// WO-177 (Chiron's ticket; Joey TG chiron:2485, 2515, 2547): the screen side. Synthetic screens only (this repo is public).
//   二  a verdict the record would hold the main's items on must agree with the program's own facts, where JevJudge collects Jev's answer into a
//       ScreenVerdict (and nowhere else): waiting_for_human needs no input box; usage_limit the limit message as the latest output or the program's own
//       wall; interrupted the Interrupted line as the latest output. Otherwise no verdict (the record is statusOf's) and an exception contradicts_program
//   五  a new version of the judge (JevJudge: the questions file's sha) is a new judge: the answers and the cache are dropped, a screen that did not change is
//       asked again; the question bank writes it again under the new version, the row carrying it; /healthz shows the version
//   六  after a restart /healthz keeps Onsen's since while the state has not changed (StatusFacts asks Onsen once)
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScreenStatus, VERDICT_MENUS, VERDICT_STATES, regionParts, regions, type ScreenDeps, type ScreenJudge, type ScreenVerdict } from './screen-status.ts'
import { JevJudge, contradiction, type JevAnswer } from './screen-judge-jev.ts'
import { StatusFacts, type StatusView } from './onsen-status.ts'

const R = '─'.repeat(80)
const screen = (above: string[], below: string[] = ['  Opus 5.5 · 7d 71%', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'], box = '❯ ') =>
  ['', ...above, '', R, box, R, ...below, '', ''].join('\n')
const IDLE = screen(['⏺ Done: the report is written.', '', '✻ Worked for 17s · done 1:37 AM'])
const MENU = ['', '   Select model', '   Switch between Claude models.', '   ❯ 1. Default (recommended)', '     2. Opus',
  '   Enter to set as default · s to use this session only · Esc to cancel', ''].join('\n')
const INTERRUPTED = screen(['✻ Churned for 6s · done 12:07 AM', '  ⎿  Interrupted · What should Claude do instead?'])
const OLD_INTERRUPTED = screen(['  ⎿  Interrupted · What should Claude do instead?', '', '⏺ Picked it up again and finished.', '', '✻ Worked for 9s · done 12:09 AM'])
const LIMIT = screen(['⏺ Working on it.', "  ⎿  You've hit your session limit · resets 5am (UTC)"])
const OLD_LIMIT = screen(["  ⎿  You've hit your weekly limit · resets Mon 5am", '', '⏺ Back at it: done.', '', '✻ Worked for 4s · done 9:00 AM'])
const T0 = Date.parse('2026-11-26T03:00:00.000Z')
const prog = (state: StatusView['state'], detail: Record<string, unknown> = {}): StatusView => ({ state, detail: { queued_joey: 0, ...detail }, last_activity_at: '2026-11-26T02:59:00.000Z' })
const WALL = { walled: { until: '2026-11-26T05:00:00.000Z', kind: 'session' } }
const V = (state: ScreenVerdict['state'], menu: ScreenVerdict['menu'] = 'none', p = 0.9): ScreenVerdict => ({ state, menu, p, by: 'jev' })
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))
const lines = (f: string): any[] => { try { return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }

function reader(judge: () => ScreenJudge | null, o: { dir?: string; clock?: { t: number }; opts?: Record<string, number>; program?: () => StatusView } = {}) {
  const dir = o.dir ?? tmp('wo177-reader-'), clock = o.clock ?? { t: T0 }
  const st = { program: prog('idle'), published: 0, logs: [] as string[] }
  const deps: ScreenDeps = { agent: 'lab-test', lanesDir: dir, switchOn: () => true, judge, snap: async () => null, isClaude: c => c !== 'zsh',
    program: o.program ?? (() => st.program), publish: () => { st.published++ }, log: (_l, m) => { st.logs.push(m) }, now: () => clock.t }
  const s = new ScreenStatus(deps, { retryMs: 30, ...(o.opts ?? {}) })
  s.active()
  return { s, st, dir, clock, bank: () => lines(join(dir, 'run', 'screen-verdicts.jsonl')) }
}
const jevFor = (v: ScreenVerdict): JevAnswer => ({ answers: { state: { choice: v.state, confidence: v.p, probabilities: { [v.state]: v.p } }, fits_any: { noul: 0.95 },
  menu: { choice: v.menu, probabilities: { [v.menu]: 0.5 } } }, ms: 150, usage: { input_tokens: 2000 }, model: 'jev-1.14.0' })
function questions(dir: string, version: number): string {
  const qp = join(dir, 'questions.json')
  writeFileSync(qp, JSON.stringify({ version, model: 'jev-1.14.0', setting: 'S'.repeat(version), publish_when_state_probability_at_least: 0.6,
    questions: { state: { type: 'choice', instructions: 'x', criteria: Object.fromEntries([...VERDICT_STATES, 'not_claude', 'other'].map(k => [k, k])) }, fits_any: { type: 'noul', instructions: 'y' },
      menu: { type: 'choice', instructions: 'z', criteria: Object.fromEntries(VERDICT_MENUS.map(k => [k, k])) } } }))
  return qp
}
function jevJudge(dir: string, answer: (state: any) => JevAnswer, r: { s?: ScreenStatus }, program: () => StatusView, version = 7): JevJudge {
  const qp = questions(dir, version)
  return new JevJudge({ agent: 'lab-test', lanesDir: dir, hasKey: () => true, questionsPath: qp, ask: async state => answer(state), logCall: () => {}, log: () => {},
    program, published: p => r.s ? r.s.view(p) : p, holds: (h, v) => !!r.s?.holds(h, v) }, { settleMs: 5 })
}

describe('二 a verdict that would hold items must agree with the program\'s facts (JevJudge, where Jev\'s answer becomes a ScreenVerdict)', () => {
  test('the rule: waiting ↔ no input box; usage_limit ↔ the limit message latest, or the program\'s wall; interrupted ↔ Interrupted latest; the other states are not checked', () => {
    expect(contradiction(V('waiting_for_human', 'model_picker'), regions(MENU), prog('idle'))).toBeNull()
    expect(contradiction(V('waiting_for_human', 'permission'), regions(IDLE), prog('idle'))).toBe('has_input_box === false')
    expect(contradiction(V('usage_limit'), regions(LIMIT), prog('idle'))).toBeNull()
    expect(contradiction(V('usage_limit'), regions(OLD_LIMIT), prog('idle'))).toMatch(/^limit_message_is_latest_output/)   // the residue of an old limit (WO-169 lab)
    expect(contradiction(V('usage_limit'), regions(IDLE), prog('idle'))).toMatch(/^limit_message_is_latest_output/)
    expect(contradiction(V('usage_limit'), regions(IDLE), prog('idle', WALL))).toBeNull()                                   // usage_wall.py / a StopFailure wall
    expect(contradiction(V('interrupted'), regions(INTERRUPTED), prog('idle'))).toBeNull()
    expect(contradiction(V('interrupted'), regions(OLD_INTERRUPTED), prog('idle'))).toBe('interrupted_is_latest_output === true')
    expect(contradiction(V('interrupted'), regions(IDLE), prog('idle'))).toBe('interrupted_is_latest_output === true')
    for (const s of ['idle', 'idle_background_running'] as const) expect(contradiction(V(s), regions(IDLE), prog('idle'))).toBeNull()   // WO-177 ③: working, compacting, starting are checked too (screen-status-wo177b)
  })

  for (const [name, text, v, p] of [
    ['waiting_for_human on a screen with an input box', IDLE, V('waiting_for_human', 'permission'), prog('idle')],
    ['usage_limit with an old limit line and no wall of the program', OLD_LIMIT, V('usage_limit', 'none'), prog('idle')],
    ['interrupted with the Interrupted line no longer the latest output', OLD_INTERRUPTED, V('interrupted'), prog('idle')],
  ] as const) {
    test(`a counter-example — ${name}: no verdict, the record is statusOf's (not held), an exception contradicts_program`, async () => {
      const ref: { s?: ScreenStatus } = {}, h: { j: ScreenJudge | null } = { j: null }
      const r = reader(() => h.j, { opts: { activeCheckMs: 0 }, program: () => p })
      h.j = jevJudge(r.dir, () => jevFor(v), ref, () => p)
      ref.s = r.s; r.s.active()
      expect(await h.j.judge(regionParts(text))).toBeNull()
      r.s.sample(text, '2.1.322')
      await wait(20)
      const rec = r.s.view(p, true)
      expect(rec).toMatchObject({ state: 'idle', detail: { judged_by: 'program' } })
      const exc = lines(join(r.dir, 'run', 'screen-exceptions.jsonl'))
      expect(exc.length).toBeGreaterThan(0)
      for (const e of exc) {
        expect(e.kinds).toContain('contradicts_program')
        expect(e.jev.contradicts).toMatchObject({ state: v.state })
      }
      expect(r.bank()).toHaveLength(0)                                       // no verdict: nothing banked
    })
  }

  test('the same states where the facts agree: a verdict, the record holds (waiting, walled, idle interrupted)', async () => {
    for (const [text, v, p, want] of [[MENU, V('waiting_for_human', 'model_picker'), prog('idle', { dialog_open: true }), 'waiting'],
      [LIMIT, V('usage_limit'), prog('idle'), 'walled'], [IDLE, V('usage_limit'), prog('idle', WALL), 'walled'], [INTERRUPTED, V('interrupted'), prog('idle'), 'idle']] as const) {
      const ref: { s?: ScreenStatus } = {}, h: { j: ScreenJudge | null } = { j: null }
      const r = reader(() => h.j, { opts: { activeCheckMs: 0 }, program: () => p })
      h.j = jevJudge(r.dir, () => jevFor(v), ref, () => p)
      ref.s = r.s; r.s.active()
      r.s.sample(text, '2.1.322')
      await wait(20)
      const rec = r.s.view(p, true)
      expect(rec.state).toBe(want)
      expect(rec.detail!.judged_by).toBe('jev')
      if (v.state === 'interrupted') expect(rec.detail!.interrupted).toBe(true)
      expect(lines(join(r.dir, 'run', 'screen-exceptions.jsonl')).filter(e => e.kinds.includes('contradicts_program'))).toEqual([])
    }
  })
})

describe('五 a new version of the judge is a new judge: answers dropped, the same screen asked again, banked again under the version', () => {
  class VersionedJudge implements ScreenJudge {
    readonly name = 'fake'
    n = 0
    ver = 'aaaaaaaaaaaa'
    gate: Promise<void> | null = null
    constructor(public answer: () => ScreenVerdict | null) {}
    version() { return this.ver }
    async judge() { this.n++; if (this.gate) await this.gate; return this.answer() }
  }

  test('a screen that does not change: asked once; the version changes → within activeCheckMs its answer is dropped and it is asked again; the bank has the second row; /healthz shows the version', async () => {
    const clock = { t: T0 }
    const j = new VersionedJudge(() => V('idle', 'none', 0.95))
    const r = reader(() => j, { clock, opts: { activeCheckMs: 10_000 } })
    r.s.sample(IDLE, '2.1.322'); await wait(2)
    clock.t += 1000; r.s.sample(IDLE, '2.1.322'); await wait(2)
    expect(j.n).toBe(1)
    expect(r.s.health()).toMatchObject({ judge_version: 'aaaaaaaaaaaa', answered: { judge_version: 'aaaaaaaaaaaa', verdict: true } })
    expect(r.bank().map(b => b.judge_version)).toEqual(['aaaaaaaaaaaa'])
    j.ver = 'bbbbbbbbbbbb'
    clock.t += 5_000; r.s.tick(); r.s.sample(IDLE, '2.1.322'); await wait(2)
    expect(j.n).toBe(1)                                                      // not looked at again before activeCheckMs
    clock.t += 6_000
    expect(r.s.active()).toBe(true)                                          // the reader's check: the version is new
    expect(r.s.health().answer).toBeNull()                                   // the old answer is gone with the old version
    r.s.sample(IDLE, '2.1.322'); await wait(2)
    expect(j.n).toBe(2)
    expect(r.s.health()).toMatchObject({ judge_version: 'bbbbbbbbbbbb', answered: { judge_version: 'bbbbbbbbbbbb' }, answer: { state: 'idle' } })
    const bank = r.bank()
    expect(bank.map(b => b.judge_version)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
    expect(bank[0].hash).toBe(bank[1].hash)                                  // the same screen, again under the new version
    expect(r.st.logs.some(l => /now judges by version bbbbbbbbbbbb \(was aaaaaaaaaaaa\)/.test(l))).toBe(true)
    // a restart the same day: neither version's row is written again
    const r2 = reader(() => j, { dir: r.dir, clock })
    r2.s.sample(IDLE, '2.1.322'); await wait(2)
    expect(r2.bank()).toHaveLength(2)
  })

  test('the version changes while a call is out: that answer is the old version\'s, dropped; asked again under the new one', async () => {
    const clock = { t: T0 }
    let open!: () => void
    const j = new VersionedJudge(() => V('working'))
    j.gate = new Promise(res => { open = res })
    const r = reader(() => j, { clock })
    r.s.sample(IDLE, '2.1.322')
    expect(j.n).toBe(1)
    j.ver = 'cccccccccccc'; j.gate = null
    open(); await wait(5)
    expect(j.n).toBe(1)                                                      // dropped (asked again at the next look: the screen was cleared)
    expect(r.s.health().answer).toBeNull()
    r.s.sample(IDLE, '2.1.322'); await wait(2)
    expect(j.n).toBe(2)
    expect(r.s.health()).toMatchObject({ judge_version: 'cccccccccccc', answered: { judge_version: 'cccccccccccc' } })
    expect(r.bank().map(b => b.judge_version)).toEqual(['cccccccccccc'])
  })

  test('JevJudge: its version is the questions file\'s sha; Chiron rewrites the file → the reader asks Jev again about the same screen', async () => {
    const clock = { t: T0 }
    const ref: { s?: ScreenStatus } = {}, h: { j: JevJudge | null } = { j: null }
    let asked = 0
    const r = reader(() => h.j, { clock, opts: { activeCheckMs: 10_000 } })
    h.j = jevJudge(r.dir, () => { asked++; return jevFor(V('idle', 'none', 0.95)) }, ref, () => prog('idle'), 7)
    ref.s = r.s; clock.t += 20_000; r.s.active()
    const v1 = h.j.version()
    expect(v1).toMatch(/^[0-9a-f]{12}$/)
    expect(r.s.health()).toMatchObject({ judge_version: v1, questions: { version: 7, sha: v1 } })
    r.s.sample(IDLE, '2.1.322'); await wait(10)
    expect(asked).toBe(1)
    questions(r.dir, 8)                                                      // a new version (another size: re-read at once)
    const v2 = h.j.version()
    expect(v2).not.toBe(v1)
    clock.t += 11_000; r.s.active()
    r.s.sample(IDLE, '2.1.322'); await wait(10)
    expect(asked).toBe(2)
    expect(r.s.health()).toMatchObject({ judge_version: v2, questions: { version: 8, sha: v2 }, answered: { judge_version: v2 } })
    expect(r.bank().map(b => b.judge_version)).toEqual([v1, v2])
  })
})

describe('六 /healthz since after a restart: Onsen\'s, while the state has not changed', () => {
  const facts = (load: any, remote: () => Promise<any>, saved: any[]) => new StatusFacts({ agent: 'lab-test', sink: () => {}, heartbeatMs: 0, now: () => T0,
    since: { load: () => load, save: x => { saved.push(x) }, remote } })
  test('no local file (the first start of a version that keeps it): since = the first report; Onsen answers the same state → its since, and it is saved', async () => {
    const saved: any[] = []
    const f = facts(null, async () => ({ state: 'idle', since: '2026-11-25T22:00:00.000000+00:00' }), saved)   // Onsen's spelling
    f.update(prog('idle'))
    expect(f.current()!.since).toBe(new Date(T0).toISOString())
    await wait(5)
    expect(f.current()!.since).toBe('2026-11-25T22:00:00.000Z')
    expect(saved.at(-1)).toEqual({ state: 'idle', since: '2026-11-25T22:00:00.000Z' })
  })
  test('a stale local file is overruled by Onsen; Onsen in another state, or a state change before it answers: this daemon\'s since stays', async () => {
    let saved: any[] = []
    let f = facts({ state: 'idle', since: '2026-11-20T00:00:00.000Z' }, async () => ({ state: 'idle', since: '2026-11-25T22:00:00.000Z' }), saved)
    f.update(prog('idle')); await wait(5)
    expect(f.current()!.since).toBe('2026-11-25T22:00:00.000Z')
    saved = []
    f = facts(null, async () => ({ state: 'busy', since: '2026-11-25T22:00:00.000Z' }), saved)
    f.update(prog('idle')); await wait(5)
    expect(f.current()!.since).toBe(new Date(T0).toISOString())
    let answer!: (x: any) => void
    f = facts(null, () => new Promise(r => { answer = r }), [])
    f.update(prog('idle')); f.update(prog('busy')); f.update(prog('idle'))
    answer({ state: 'idle', since: '2026-11-25T22:00:00.000Z' }); await wait(5)
    expect(f.current()!.since).not.toBe('2026-11-25T22:00:00.000Z')            // idle again after a change: not the idle Onsen held before the restart
    f = facts(null, async () => { throw new Error('Onsen down') }, [])
    f.update(prog('idle')); await wait(5)
    expect(f.current()!.since).toBe(new Date(T0).toISOString())
  })
})
