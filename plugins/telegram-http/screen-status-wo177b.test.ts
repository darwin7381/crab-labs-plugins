// telegram-http 1.58.6 (WO-177, Chiron 03:41Z on the ticket, ③ and ⑤): synthetic screens (this repo is public); Chiron's labelled screens when this
// machine has them (~/cc-workspaces/claude-chiron/knowledge/tg-dialogue/screen-eval + labels.json + regions-v7.json).
//   ③  「任何會讓紀錄不是 idle 的 verdict，都要有一個程式事實撐著」: working needs an activity fact (a live activity line with no finished marker after it,
//       tool_running_line, esc_to_interrupt), compacting that live line saying Compacting, starting no input box. Otherwise no verdict, contradicts_program
//   ⑤  no verdict (Jev off or down, its answer not taken): a screen that shows work keeps the record busy (judged_by program); statusOf's own non-idle states
//       stand; no pane read: statusOf's view. The pane is read whenever JEV_SCREEN lists the agent, with or without a judge
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScreenStatus, Since, VERDICT_MENUS, VERDICT_STATES, composeRecord, publishView, regionParts, regions, screenActivity, type ScreenDeps, type ScreenJudge,
  type ScreenVerdict } from './screen-status.ts'
import { JevJudge, contradiction, type JevAnswer } from './screen-judge-jev.ts'
import type { StatusView } from './onsen-status.ts'

const R = '─'.repeat(80)
const screen = (above: string[], below: string[] = ['  Opus 5.5 · 7d 71%', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'], box = '❯ ') =>
  ['', ...above, '', R, box, R, ...below, '', ''].join('\n')
const IDLE = screen(['⏺ Done: the report is written.', '', '✻ Worked for 17s · done 1:37 AM'])
const THINKING = screen(['⏺ Reading the logs.', '', '✻ Pondering… (12s · ↓ 1.2k tokens)'])                       // a live activity line, nothing after it
const TOOL = screen(['⏺ Bash(sleep 60)', '  ⎿  Running…'])                                                       // a tool running, no activity line
const ESC = screen(['⏺ Still going.'], ['  esc to interrupt'])                                                    // only "esc to interrupt"
const COMPACT = screen(['✻ Compacting conversation… (12s)'])
const OLD_ACTIVITY = screen(['✻ Pondering… (3s)', '⏺ Done.', '✻ Worked for 4s · done 1:40 AM'])                    // the activity line, a finished marker after it
const NOBOX = ['', '  Claude Code v2.1.322', '  Loading…', ''].join('\n')                                       // no input box yet
const prog = (state: StatusView['state'], detail: Record<string, unknown> = {}): StatusView => ({ state, detail: { queued_joey: 0, ...detail }, last_activity_at: '2026-11-26T03:59:00.000Z' })
const V = (state: ScreenVerdict['state'], menu: ScreenVerdict['menu'] = 'none', p = 0.9): ScreenVerdict => ({ state, menu, p, by: 'jev' })
const T0 = Date.parse('2026-11-26T04:00:00.000Z')
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))
const lines = (f: string): any[] => { try { return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }

describe('③ every verdict that makes the record not idle needs a program fact', () => {
  test('screenActivity reads the three activity facts: a live line with no finished marker after it, Running…, esc to interrupt; compacting = that live line says Compacting', () => {
    expect(screenActivity(regions(THINKING))).toEqual({ busy: true, compacting: false })
    expect(screenActivity(regions(TOOL))).toEqual({ busy: true, compacting: false })
    expect(screenActivity(regions(ESC))).toEqual({ busy: true, compacting: false })
    expect(screenActivity(regions(COMPACT))).toEqual({ busy: true, compacting: true })
    expect(screenActivity(regions(IDLE))).toEqual({ busy: false, compacting: false })
    expect(screenActivity(regions(OLD_ACTIVITY))).toEqual({ busy: false, compacting: false })
  })
  test('the rule: working ↔ an activity fact; compacting ↔ a live Compacting line; starting ↔ no input box', () => {
    for (const t of [THINKING, TOOL, ESC, COMPACT]) expect(contradiction(V('working'), regions(t), prog('busy'))).toBeNull()
    for (const t of [IDLE, OLD_ACTIVITY]) expect(contradiction(V('working'), regions(t), prog('idle'))).toMatch(/^an activity fact/)
    expect(contradiction(V('compacting'), regions(COMPACT), prog('idle'))).toBeNull()
    for (const t of [IDLE, THINKING, TOOL]) expect(contradiction(V('compacting'), regions(t), prog('idle'))).toMatch(/Compacting/)
    expect(contradiction(V('starting'), regions(NOBOX), prog('offline', { reason: 'no_registration' }))).toBeNull()
    expect(contradiction(V('starting'), regions(IDLE), prog('idle'))).toBe('has_input_box === false')
    for (const s of ['idle', 'idle_background_running'] as const) for (const t of [IDLE, THINKING]) expect(contradiction(V(s), regions(t), prog('idle'))).toBeNull()   // an idle record needs none
  })
  const EVAL = join(homedir(), 'cc-workspaces', 'claude-chiron', 'knowledge', 'tg-dialogue', 'screen-eval')
  test.skipIf(!existsSync(join(EVAL, 'labels.json')) || !existsSync(join(EVAL, 'regions-v7.json')))("Chiron's labelled screens (as many as regions-v7.json has): the facts are regions-v7.json's; working and compacting have them, the others none; no labelled verdict is contradicted", () => {
    const labels = JSON.parse(readFileSync(join(EVAL, 'labels.json'), 'utf8')) as Record<string, { state: string }>
    const v7 = JSON.parse(readFileSync(join(EVAL, 'regions-v7.json'), 'utf8')).regions as Record<string, unknown>
    const by: Record<string, number> = {}
    for (const [f, l] of Object.entries(labels)) {
      const st = regions(readFileSync(join(EVAL, f), 'utf8'))
      expect(st).toEqual(v7[f] as any)
      const a = screenActivity(st)
      expect([f, a.busy]).toEqual([f, l.state === 'working' || l.state === 'compacting'])
      expect([f, a.compacting]).toEqual([f, l.state === 'compacting'])
      if ((VERDICT_STATES as readonly string[]).includes(l.state)) expect([f, contradiction(V(l.state as ScreenVerdict['state']), st, prog('idle'))]).toEqual([f, null])
      by[l.state] = (by[l.state] ?? 0) + 1
    }
    // the count is the fixture's (Chiron adds screens: 64, then 71 on 11-26): every labelled screen has its regions, and no region file is unlabelled
    expect(Object.keys(labels).sort()).toEqual(Object.keys(v7).sort())
    expect(by.working).toBeGreaterThan(0); expect(by.compacting).toBeGreaterThan(0)
  })
})

function questions(dir: string): string {
  const qp = join(dir, 'questions.json')
  writeFileSync(qp, JSON.stringify({ version: 7, model: 'jev-1.14.0', setting: 'S', publish_when_state_probability_at_least: 0.6,
    questions: { state: { type: 'choice', instructions: 'x', criteria: Object.fromEntries([...VERDICT_STATES, 'not_claude', 'other'].map(k => [k, k])) }, fits_any: { type: 'noul', instructions: 'y' },
      menu: { type: 'choice', instructions: 'z', criteria: Object.fromEntries(VERDICT_MENUS.map(k => [k, k])) } } }))
  return qp
}
const jevFor = (v: ScreenVerdict): JevAnswer => ({ answers: { state: { choice: v.state, confidence: v.p, probabilities: { [v.state]: v.p } }, fits_any: { noul: 0.95 },
  menu: { choice: v.menu, probabilities: { [v.menu]: 0.5 } } }, ms: 150, usage: { input_tokens: 2000 }, model: 'jev-1.14.0' })
function reader(judge: () => ScreenJudge | null, program: () => StatusView, dir = tmp('wo177b-')) {
  const st = { published: 0, logs: [] as string[] }
  const deps: ScreenDeps = { agent: 'lab-test', lanesDir: dir, switchOn: () => true, judge, snap: async () => null, isClaude: c => c !== 'zsh',
    program, publish: () => { st.published++ }, log: (_l, m) => { st.logs.push(m) }, now: () => T0 }
  const s = new ScreenStatus(deps, { retryMs: 30, activeCheckMs: 0 })
  s.active()
  return { s, st, dir }
}

describe('③ in JevJudge: a working / compacting / starting answer the screen does not bear is no verdict', () => {
  for (const [name, text, v, p] of [
    ['working on an idle screen (the activity line has a finished marker after it)', OLD_ACTIVITY, V('working'), prog('idle')],
    ['compacting on a screen whose live line is not Compacting', THINKING, V('compacting'), prog('busy')],
    ['starting on a screen with an input box', IDLE, V('starting'), prog('idle')],
  ] as const) {
    test(`${name}: null, contradicts_program; the record is the program's`, async () => {
      const dir = tmp('wo177b-j-')
      const ref: { s?: ScreenStatus } = {}
      const j = new JevJudge({ agent: 'lab-test', lanesDir: dir, hasKey: () => true, questionsPath: questions(dir), ask: async () => jevFor(v), logCall: () => {}, log: () => {},
        program: () => p, published: x => ref.s ? ref.s.view(x) : x, holds: (h, vv) => !!ref.s?.holds(h, vv) }, { settleMs: 5 })
      const r = reader(() => j, () => p, dir); ref.s = r.s
      expect(await j.judge(regionParts(text))).toBeNull()
      r.s.sample(text, '2.1.322')
      await wait(20)
      const rec = r.s.view(p, true)
      expect(rec.detail!.judged_by).toBe('program')
      expect(rec.state).toBe(p.state === 'busy' ? 'busy' : 'idle')                  // statusOf's (THINKING under statusOf busy stays busy; the others idle)
      const exc = lines(join(dir, 'run', 'screen-exceptions.jsonl'))
      expect(exc.length).toBeGreaterThan(0)
      for (const e of exc) { expect(e.kinds).toContain('contradicts_program'); expect(e.jev.contradicts).toMatchObject({ state: v.state }) }
    })
  }
  test('the same answers where the screen bears them: a verdict (working → busy, compacting → busy compacting, starting → starting)', async () => {
    for (const [text, v, p, want] of [[THINKING, V('working'), prog('idle'), 'busy'], [COMPACT, V('compacting'), prog('idle'), 'busy'],
      [NOBOX, V('starting'), prog('offline', { reason: 'no_registration' }), 'starting']] as const) {
      const dir = tmp('wo177b-k-')
      const ref: { s?: ScreenStatus } = {}
      const j = new JevJudge({ agent: 'lab-test', lanesDir: dir, hasKey: () => true, questionsPath: questions(dir), ask: async () => jevFor(v), logCall: () => {}, log: () => {},
        program: () => p, published: x => ref.s ? ref.s.view(x) : x, holds: (h, vv) => !!ref.s?.holds(h, vv) }, { settleMs: 5 })
      const r = reader(() => j, () => p, dir); ref.s = r.s
      r.s.sample(text, '2.1.322')
      await wait(20)
      const rec = r.s.view(p, true)
      expect([v.state, rec.state, rec.detail!.judged_by]).toEqual([v.state, want, 'jev'])
      if (v.state === 'compacting') expect(rec.detail!.compacting).toBe(true)
      expect(lines(join(dir, 'run', 'screen-exceptions.jsonl')).filter(e => e.kinds.includes('contradicts_program'))).toEqual([])
    }
  })
})

describe('⑤ no verdict: the program\'s own cut of the screen still holds the record busy when it shows work', () => {
  test('composeRecord(null, screen, statusOf idle): busy judged_by program on each activity fact (compacting marked); an idle screen: statusOf\'s; no screen: statusOf\'s', () => {
    for (const t of [THINKING, TOOL, ESC]) expect(publishView(null, regions(t), prog('idle'))).toMatchObject({ state: 'busy', detail: { judged_by: 'program', queued_joey: 0 } })
    expect(publishView(null, regions(COMPACT), prog('idle'))).toMatchObject({ state: 'busy', detail: { judged_by: 'program', compacting: true } })
    expect(publishView(null, regions(THINKING), prog('idle')).detail!.compacting).toBeUndefined()
    expect(publishView(null, regions(IDLE), prog('idle'))).toEqual({ ...prog('idle'), detail: { ...prog('idle').detail, judged_by: 'program' } })
    expect(publishView(null, regions(OLD_ACTIVITY), prog('idle')).state).toBe('idle')
    expect(publishView(null, null, prog('idle')).state).toBe('idle')                                           // no pane read: plain statusOf
    // the observation follows the record: the main session running in the turn the program knows (a Stop hook sent the turn back: M2 is idle, the turn goes on)
    const turn = { id: 'p-1', started_at: '2026-11-26T03:58:00.000Z', trigger: { kind: 'other' as const } }
    const o = composeRecord(null, regions(THINKING), prog('idle'), { session_id: 'x', now: T0, turn }).observation
    expect(o.sessions.find(s => s.kind === 'main')).toMatchObject({ activity: 'running', turn, doing: { kind: 'thinking' } })
  })
  test('the program\'s verdict goes the judge\'s way (the same order as a working / compacting verdict of Jev\'s): the wall stands, stuck stands, busy keeps its turn, a session with no stream is busy, gone is offline, no_registration with Claude Code is starting', () => {
    const W = { walled: { until: '2026-11-26T05:00:00.000Z', kind: 'session' } }
    for (const p of [prog('walled', W), prog('stuck', { threshold_s: 600 }), prog('busy', { turn_started_at: '2026-11-26T03:58:00.000Z', tool: 'Bash' }), prog('idle'),
      prog('offline', { reason: 'not_connected' }), prog('offline', { reason: 'pid_gone' }), prog('offline', { reason: 'no_registration' })]) {
      const jev = publishView({ ...V('working'), p: 1 }, regions(THINKING), p, { alive: true }), mine = publishView(null, regions(THINKING), p, { alive: true })
      expect([p.state, (p.detail as any).reason ?? null, mine.state, mine.detail]).toEqual([p.state, (p.detail as any).reason ?? null, jev.state, p.state === 'offline' && (p.detail as any).reason === 'pid_gone' ? jev.detail : { ...jev.detail, judged_by: 'program' }])
    }
    expect(publishView(null, regions(THINKING), prog('walled', W)).state).toBe('walled')
    expect(publishView(null, regions(THINKING), prog('stuck', { threshold_s: 600 })).state).toBe('stuck')
    expect(publishView(null, regions(THINKING), prog('busy', { turn_started_at: '2026-11-26T03:58:00.000Z', tool: 'Bash' }))).toMatchObject({ state: 'busy', detail: { tool: 'Bash' } })
    expect(publishView(null, regions(THINKING), prog('offline', { reason: 'not_connected' }))).toMatchObject({ state: 'busy', detail: { program_offline: 'not_connected', judged_by: 'program' } })
    expect(publishView(null, regions(THINKING), prog('offline', { reason: 'pid_gone' })).state).toBe('offline')
    expect(publishView(null, regions(THINKING), prog('offline', { reason: 'no_registration' }), { alive: true }).state).toBe('starting')
    expect(publishView(null, regions(THINKING), prog('idle')).detail).toMatchObject({ judged_by: 'program', judge_p: 1 })   // labels, as a judge's (WO-169: who judged reaches nothing else)
  })
  test('Jev down (every call fails): the screen showing work → busy judged_by program; the screen idle again → idle', async () => {
    const dir = tmp('wo177b-down-')
    const ref: { s?: ScreenStatus } = {}
    const j = new JevJudge({ agent: 'lab-test', lanesDir: dir, hasKey: () => true, questionsPath: questions(dir), ask: async () => ({ error: 'HTTP 400 Unknown model', ms: 40 }), logCall: () => {}, log: () => {},
      program: () => prog('idle'), published: x => ref.s ? ref.s.view(x) : x, holds: (h, vv) => !!ref.s?.holds(h, vv) }, { settleMs: 5 })
    const r = reader(() => j, () => prog('idle'), dir); ref.s = r.s
    r.s.sample(THINKING, '2.1.322')
    await wait(20)
    expect(r.s.view(prog('idle'), true)).toMatchObject({ state: 'busy', detail: { judged_by: 'program' } })
    r.s.sample(IDLE, '2.1.322')
    await wait(20)
    expect(r.s.view(prog('idle'), true)).toMatchObject({ state: 'idle', detail: { judged_by: 'program' } })
  })
  test('no judge at all (SCREEN_JUDGE=program, no key): the pane is still read (health: reading, on false) and its activity facts make the record busy', async () => {
    const r = reader(() => null, () => prog('idle'))
    expect(r.s.health()).toMatchObject({ on: false, reading: true, judge: null })
    r.s.sample(TOOL, '2.1.322')
    expect(r.st.published).toBeGreaterThan(0)
    expect(r.s.view(prog('idle'), true)).toMatchObject({ state: 'busy', detail: { judged_by: 'program' } })
    r.s.sample(IDLE, '2.1.322')
    expect(r.s.view(prog('idle'), true).state).toBe('idle')
    r.s.sample(TOOL, 'zsh')                                                    // the pane's program is not Claude Code: its screen is not the main's
    expect(r.s.view(prog('idle'), true).state).toBe('idle')
  })
  test('JEV_SCREEN does not list the agent: nothing is read, the record is statusOf\'s untouched', () => {
    const deps: ScreenDeps = { agent: 'lab-test', lanesDir: tmp('wo177b-off-'), switchOn: () => false, judge: () => null, snap: async () => null, isClaude: () => true,
      program: () => prog('idle'), publish: () => {}, log: () => {}, now: () => T0 }
    const s = new ScreenStatus(deps, { activeCheckMs: 0 }); s.active()
    s.sample(TOOL, '2.1.322')
    expect(s.view(prog('idle'), true)).toEqual(prog('idle'))
    expect(s.health()).toMatchObject({ on: false, reading: false })
  })
})

describe('doing.since is when the current doing began (Chiron 04:01Z item 2)', () => {
  test('the main: thinking → a tool → thinking again: the second thinking starts when the tool ended, not at the turn\'s start', () => {
    const mem = new Since(), turn = { id: 'p-7', started_at: '2026-11-26T03:51:27.864Z', trigger: { kind: 'other' as const } }
    const at = (ms: number) => ({ session_id: 'x', turn, now: ms, since: (k: string, v: string) => mem.at(k, v, ms) })
    const doing = (p: StatusView, ms: number) => composeRecord(V('working'), regions(THINKING), p, at(ms)).observation.sessions.find(s => s.kind === 'main')!.doing
    const t0 = Date.parse('2026-11-26T03:51:28.000Z'), t1 = t0 + 5000, t2 = t0 + 50_000
    expect(doing(prog('busy', { turn_started_at: turn.started_at }), t0)).toEqual({ kind: 'thinking', tool: null, since: new Date(t0).toISOString() })
    const tool = { name: 'Bash', since: new Date(t1).toISOString() }
    expect(doing(prog('busy', { turn_started_at: turn.started_at, tool }), t1 + 100)).toEqual({ kind: 'tool', tool: 'Bash', since: tool.since })
    expect(doing(prog('busy', { turn_started_at: turn.started_at }), t2)).toEqual({ kind: 'thinking', tool: null, since: new Date(t2).toISOString() })   // was t0
    expect(doing(prog('busy', { turn_started_at: turn.started_at }), t2 + 9000)!.since).toBe(new Date(t2).toISOString())                                   // and stays
  })
  test('a lane: thinking after its tool came back is since then (runningLanes thinking_since), before any tool since the run began', () => {
    const lane = (extra: Record<string, unknown>) => composeRecord(null, null, prog('idle', { lanes: [{ id: 'lab-relay.reflex.22', run: 'lab-relay.reflex.22.r1', since: '2026-11-26T03:53:51.089Z', ...extra }] }),
      { session_id: 'x', now: T0 }).observation.sessions.find(s => s.kind === 'lane')!.doing
    expect(lane({})).toEqual({ kind: 'thinking', tool: null, since: '2026-11-26T03:53:51.089Z' })
    expect(lane({ tool: { name: 'Bash', since: '2026-11-26T03:53:55.000Z' } })).toEqual({ kind: 'tool', tool: 'Bash', since: '2026-11-26T03:53:55.000Z' })
    expect(lane({ thinking_since: '2026-11-26T03:54:40.000Z' })).toEqual({ kind: 'thinking', tool: null, since: '2026-11-26T03:54:40.000Z' })
  })
})
