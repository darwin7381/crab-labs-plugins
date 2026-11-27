// WO-168 stage two, the record side (Chiron's ticket; his 05:24:56Z rulings 「紀錄缺的八樣都補，第 8 樣不做」; item 6 after his 05:54Z call):
//   facts      the program's facts of a screen, on REAL screens (test-fixtures/wo168/README.md): a menu open (no input box and a selection footer, or a
//              layout the program knows), its options word for word with the cursor, its question, real text typed in the input box (escapes kept)
//   record     every menu kind carries waiting_text and menu_options; the kind is kept while walled or starting; detail.screen says which screen and when;
//              with no judge (Jev down, SCREEN_JUDGE=program) a menu still shows as waiting (judged_by program)
//   recordOf   the record for exactly one look (never another screen's verdict)
//   item 6     refusal_fallback and switch_confirm known before questions v8; a kind the daemon does not know is `other` with menu_raw, not a lost verdict;
//              v7 (kinds absent) and v8 (kinds present) both work; the observation sends Onsen only the kinds it takes
//   one look   pane-look.ts: the escapes stripped as `capture-pane -p` gives them; the reader shares one capture, feeds the record once per look; a
//              real tmux capture on a PRIVATE server (-S, TMUX unset) splits scrollback from the visible rows
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScreenStatus, VERDICT_MENUS, VERDICT_STATES, composeRecord, inputTyped, programVerdict, publishView, regionParts, screenFacts, screenHash,
  type ScreenDeps, type ScreenJudge, type ScreenVerdict } from './screen-status.ts'
import { JevJudge, verdictOf, type JevAnswer } from './screen-judge-jev.ts'
import { PaneReader, snapPaneLook, splitVisible, stripAnsi, type PaneLook } from './pane-look.ts'
import type { StatusView } from './onsen-status.ts'

const FX = join(import.meta.dir, 'test-fixtures', 'wo168')
const fx = (f: string): string => readFileSync(join(FX, f), 'utf8')
const T0 = Date.parse('2026-11-26T06:00:00Z')
/** a look of one of the real captures: its plain rows and its rows with escapes */
const lookOf = (name: string, at = T0, seq = 1, cmd = '2.1.322'): PaneLook => {
  const ansi = fx(`${name}.ansi`).replace(/\n$/, '')
  return { at, seq, cmd, inMode: false, path: '/nowhere', visible: stripAnsi(ansi), visibleAnsi: ansi, text: stripAnsi(ansi) }
}
/** a look of a plain-text real screen (no escapes kept: input_typed unknown) */
const lookTxt = (file: string, at = T0, seq = 1): PaneLook => { const t = fx(file); return { at, seq, cmd: '2.1.322', inMode: false, path: '/nowhere', visible: t, visibleAnsi: t, text: t } }
const factsOf = (t: string, ansi: string | null = null) => screenFacts(t, ansi, regionParts(t).st)
const prog = (state: StatusView['state'], detail: Record<string, unknown> = {}): StatusView => ({ state, detail: { queued_joey: 0, ...detail }, last_activity_at: '2026-11-26T05:59:00.000Z' })
const V = (state: ScreenVerdict['state'], menu: ScreenVerdict['menu'] = 'none', p = 0.95): ScreenVerdict => ({ state, menu, p, by: 'jev' })

describe('facts: real screens', () => {
  test('stripping the escapes of `capture-pane -e` gives `capture-pane -p` row for row (every txmonster capture)', () => {
    for (const n of ['cc-01-start', 'cc-01b-trust-down', 'cc-02-idle', 'cc-03-typed', 'cc-04-cleared', 'cc-05-model', 'cc-09-effort']) {
      const a = stripAnsi(fx(`${n}.ansi`)).replace(/\n$/, '').split('\n').map(r => r.replace(/\s+$/, ''))
      const p = fx(`${n}.plain`).replace(/\n$/, '').split('\n').map(r => r.replace(/\s+$/, ''))
      expect({ n, rows: a }).toEqual({ n, rows: p })
      expect(fx(`${n}.ansi`)).toContain('\x1b[')                                       // the capture did keep escapes
    }
  })
  test('input_typed: the dim suggestion is not typed, real text is (the box\'s escapes); no escapes: unknown', () => {
    expect(factsOf(lookOf('cc-02-idle').visible, lookOf('cc-02-idle').visibleAnsi)).toMatchObject({ menu_open: false, input_typed: false })   // ❯ Try "write a test…" (dim)
    expect(factsOf(lookOf('cc-03-typed').visible, lookOf('cc-03-typed').visibleAnsi)).toMatchObject({ menu_open: false, input_typed: true })  // ❯ hello there
    expect(factsOf(lookOf('cc-04-cleared').visible, lookOf('cc-04-cleared').visibleAnsi)).toMatchObject({ input_typed: false })
    expect(factsOf(fx('cc-03-typed.plain'))).toMatchObject({ input_typed: null })
    expect(inputTyped(['\x1b[39m❯\xa0\x1b[2mTry "x"\x1b[22m'])).toBe(false)
    expect(inputTyped(['\x1b[39m❯\xa0\x1b[2mTry\x1b[22m and more'])).toBe(true)
    expect(inputTyped(['❯\xa0', '  \x1b[2;3msuggested\x1b[0m'])).toBe(false)
  })
  test('the model picker (2.1.322, txmonster): options word for word, the cursor on 1, the question', () => {
    const f = factsOf(lookOf('cc-05-model').visible)
    expect(f.menu_open).toBe(true)
    expect(f.menu_kind).toBeNull()                                                     // the judge names model_picker
    expect(f.options).toEqual([
      { n: 1, text: 'Default (recommended) ✔  Sonnet 5.5 · Efficient for routine tasks', cursor: true },
      { n: 2, text: 'Sonnet                   Sonnet 5.5 · Efficient for routine tasks', cursor: false },
      { n: 3, text: 'Fable                    Fable 5.2 · Most capable for your hardest and longest-running tasks', cursor: false },
      { n: 4, text: 'Opus                     Opus 5.5 · Best for everyday, complex tasks', cursor: false },
      { n: 5, text: 'Haiku                    Haiku 5.5 · Fastest for quick answers', cursor: false }])
    expect(f.question).toBe('Select model\nSwitch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.')
  })
  test('the trust prompt (unnumbered, 2.1.322): both options, the cursor where the screen has it', () => {
    expect(factsOf(lookOf('cc-01-start').visible).options).toEqual([{ n: null, text: 'No, exit', cursor: true }, { n: null, text: 'Yes, I trust this folder', cursor: false }])
    expect(factsOf(lookOf('cc-01b-trust-down').visible).options).toEqual([{ n: null, text: 'No, exit', cursor: false }, { n: null, text: 'Yes, I trust this folder', cursor: true }])
    expect(factsOf(lookOf('cc-01-start').visible).question).toContain('Quick safety check: Is this a project you created or one you trust?')
  })
  test('a panel or slider with no options is still a menu open (the effort slider, the Help page, the resume list)', () => {
    expect(factsOf(lookOf('cc-09-effort').visible)).toMatchObject({ menu_open: true, options: [], menu_kind: null })
    expect(factsOf(lookOf('cc-09-effort').visible).question.startsWith('Effort')).toBe(true)             // the border with the effort hint on it is the top
    expect(factsOf(fx('lab-help-panel.txt'))).toMatchObject({ menu_open: true, options: [], menu_kind: null })
    expect(factsOf(fx('lab-resume-picker.txt'))).toMatchObject({ menu_open: true, menu_kind: 'resume_picker' })
  })
  test('the usage-limit options (lab-relay): kind, both options, the question', () => {
    expect(factsOf(fx('lab-limit-options-menu.txt'))).toEqual({ menu_open: true, menu_kind: 'usage_limit_options', question: 'What do you want to do?',
      options: [{ n: 1, text: 'Stop and wait for limit to reset', cursor: true }, { n: 2, text: 'Wait here, then continue automatically at Dec 1, 6am', cursor: false }], input_typed: null })
  })
  test('item 6: the refusal-fallback picker, both layouts (layout 2 draws no footer; a task list sits under layout 1\'s)', () => {
    expect(factsOf(fx('refusal-fallback-1.txt'))).toMatchObject({ menu_open: true, menu_kind: 'refusal_fallback', options: [
      { n: 1, text: 'Switch automatically', cursor: true }, { n: 2, text: 'Stay on Opus 5.5', cursor: false }, { n: 3, text: 'Type something.', cursor: false },
      { n: 4, text: 'Chat about this', cursor: false }] })
    for (const f of ['refusal-fallback-2.txt', 'refusal-fallback-3.txt']) {
      expect(factsOf(fx(f))).toMatchObject({ menu_open: true, menu_kind: 'refusal_fallback',
        options: [{ n: 1, text: 'Switch to Opus 4.8', cursor: true }, { n: 2, text: 'Edit prompt and retry with Opus 5.5', cursor: false }] })
      expect(factsOf(fx(f)).question.startsWith('Session paused')).toBe(true)
    }
  })
  test('item 6: the Switch model? confirm (no footer): kind switch_confirm, Yes on the cursor', () => {
    for (const [f, m] of [['yes-no-confirm-1.txt', 'Fable 5'], ['yes-no-confirm-2.txt', 'Opus 5'], ['yes-no-confirm-3.txt', 'Fable 5']]) {
      expect(factsOf(fx(f!))).toMatchObject({ menu_open: true, menu_kind: 'switch_confirm',
        options: [{ n: 1, text: `Yes, switch to ${m}`, cursor: true }, { n: 2, text: 'No, go back', cursor: false }] })
      expect(factsOf(fx(f!)).question.startsWith('Switch model?')).toBe(true)
    }
  })
})

describe('record: the screen layer\'s new fields', () => {
  const look = lookOf('cc-05-model'), parts = regionParts(look.visible), facts = screenFacts(look.visible, look.visibleAnsi, parts.st)
  const sc = { hash: screenHash(parts), seen_at: look.at, facts }
  test('every menu kind: waiting_text (its question) and menu_options; which screen and when (detail.screen)', () => {
    for (const m of VERDICT_MENUS.filter(x => x !== 'none')) {
      const r = composeRecord(V('waiting_for_human', m), parts.st, prog('idle'), {}, sc).view
      expect(r).toMatchObject({ state: 'waiting', detail: { waitingFor: m, waiting_text: facts.question, judged_by: 'jev', screen: { hash: sc.hash, seen_at: '2026-11-26T06:00:00.000Z' } } })
      expect((r.detail as any).menu_options).toEqual(facts.options)
    }
    expect(publishView(V('waiting_for_human', 'other'), parts.st, prog('idle'))).toMatchObject({ detail: { waitingFor: 'other', waiting_text: expect.any(String) } })   // no screen ctx: as before
  })
  test('the menu kind is kept while walled, and while starting; the order of states is unchanged', () => {
    const wall = { walled: { until: '2026-12-01T06:00:00.000Z', kind: 'weekly' } }
    expect(composeRecord(V('waiting_for_human', 'usage_limit_options'), parts.st, prog('busy', wall), {}, sc).view).toMatchObject({ state: 'walled',
      detail: { walled: wall.walled, waitingFor: 'usage_limit_options', waiting_text: facts.question, menu_options: facts.options } })
    expect(composeRecord(V('waiting_for_human', 'trust_folder'), parts.st, prog('offline', { reason: 'no_registration' }), { alive: true }, sc).view).toMatchObject({ state: 'starting',
      detail: { waitingFor: 'trust_folder', menu_options: facts.options } })
    // walled, the judge says idle, the program's facts see a menu on this screen: the record keeps what is on the screen (kind other: no judge named it)
    expect(composeRecord(V('idle'), parts.st, prog('busy', wall), {}, sc).view).toMatchObject({ state: 'walled', detail: { waitingFor: 'other', menu_options: facts.options } })
    const idle = lookOf('cc-02-idle'), ip = regionParts(idle.visible)
    expect(composeRecord(V('idle'), ip.st, prog('busy', wall), {}, { hash: 'h', seen_at: T0, facts: screenFacts(idle.visible, idle.visibleAnsi, ip.st) }).view.detail).not.toHaveProperty('waitingFor')
  })
  test('no judge (Jev down, SCREEN_JUDGE=program): a menu on the screen is waiting, judged_by program, with its program kind or other', () => {
    expect(composeRecord(null, parts.st, prog('idle'), {}, sc).view).toMatchObject({ state: 'waiting', detail: { waitingFor: 'other', judged_by: 'program', judge_p: 1, menu_options: facts.options } })
    for (const [f, kind] of [['lab-limit-options-menu.txt', 'usage_limit_options'], ['refusal-fallback-2.txt', 'refusal_fallback'], ['yes-no-confirm-2.txt', 'switch_confirm'], ['lab-resume-picker.txt', 'resume_picker']]) {
      const t = fx(f!), p = regionParts(t), x = screenFacts(t, null, p.st)
      expect(programVerdict(p.st, x)).toEqual({ state: 'waiting_for_human', menu: kind as any, p: 1, by: 'program' })
      expect(composeRecord(null, p.st, prog('idle'), {}, { hash: screenHash(p), seen_at: T0, facts: x }).view).toMatchObject({ state: 'waiting', detail: { waitingFor: kind, judged_by: 'program' } })
    }
    const idle = lookOf('cc-02-idle'), ip = regionParts(idle.visible)
    expect(programVerdict(ip.st, screenFacts(idle.visible, idle.visibleAnsi, ip.st))).toBeNull()
  })
  test('input_typed and detail.screen ride every record composed from a screen with an input box', () => {
    for (const [n, typed] of [['cc-02-idle', false], ['cc-03-typed', true]] as const) {
      const l = lookOf(n), p = regionParts(l.visible)
      const r = composeRecord(V('idle'), p.st, prog('idle'), {}, { hash: screenHash(p), seen_at: l.at, facts: screenFacts(l.visible, l.visibleAnsi, p.st) }).view
      expect(r).toMatchObject({ state: 'idle', detail: { input_typed: typed, screen: { hash: screenHash(p) } } })
    }
  })
  test('the observation sends Onsen only the menu kinds it takes (its v1 list): refusal_fallback and switch_confirm go as other', () => {
    for (const m of ['refusal_fallback', 'switch_confirm'] as const) {
      const o = composeRecord(V('waiting_for_human', m), parts.st, prog('idle'), { session_id: 's', now: T0 }, sc).observation
      expect(o.sessions[0]!.blockers.map(b => b.menu_kind)).toEqual(['other'])
    }
    const t = fx('lab-limit-options-menu.txt'), p = regionParts(t)
    const o = composeRecord(null, p.st, prog('idle'), { session_id: 's', now: T0 }, { hash: screenHash(p), seen_at: T0, facts: screenFacts(t, null, p.st) }).observation
    expect(o.sessions[0]!.blockers.map(b => b.menu_kind)).toEqual(['usage_limit_options'])   // the program's kind reaches the blocker
  })
})

describe('item 6: questions v7 and v8, and a kind newer than both', () => {
  const read = (state: string, menu: string, p = 0.97) => ({ state, p, conf: p, probs: { [state]: p }, fits_any: 0.9, menu, menu_p: p, menu_probs: { [menu]: p } })
  test('verdictOf: a kind in the lists is taken; a kind outside them is other with menu_raw (before WO-168: no verdict)', () => {
    expect(verdictOf(read('waiting_for_human', 'refusal_fallback'), 0.6)).toEqual({ state: 'waiting_for_human', menu: 'refusal_fallback', p: 0.97, by: 'jev' })
    expect(verdictOf(read('waiting_for_human', 'switch_confirm'), 0.6)).toEqual({ state: 'waiting_for_human', menu: 'switch_confirm', p: 0.97, by: 'jev' })
    expect(verdictOf(read('waiting_for_human', 'theme_picker'), 0.6)).toEqual({ state: 'waiting_for_human', menu: 'other', p: 0.97, by: 'jev', menu_raw: 'theme_picker' })
    expect(verdictOf(read('not_claude', 'none'), 0.6)).toBeNull()                       // a state outside the lists is still no verdict
    const t = fx('refusal-fallback-2.txt'), p = regionParts(t)
    expect(composeRecord(verdictOf(read('waiting_for_human', 'theme_picker'), 0.6), p.st, prog('idle'), {}, { hash: 'h', seen_at: T0, facts: screenFacts(t, null, p.st) }).view)
      .toMatchObject({ state: 'waiting', detail: { waitingFor: 'refusal_fallback', menu_raw: 'theme_picker', judged_by: 'jev' } })   // other, and the program knows the layout
  })
  // the real JevJudge, through the real reader, with a v7-shaped questions file (no refusal_fallback / switch_confirm) and a v8-shaped one
  const jevRun = async (kinds: readonly string[], answer: string): Promise<StatusView> => {
    const dir = mkdtempSync(join(tmpdir(), 'wo168-q-'))
    const qp = join(dir, 'questions.json')
    writeFileSync(qp, JSON.stringify({ version: 8, model: 'jev-1.14.0', setting: 'S', publish_when_state_probability_at_least: 0.6, if_menu_is_not_none_with_probability_at_least: 0.6,
      then_state: 'waiting_for_human', questions: { state: { type: 'choice', instructions: 'x', criteria: Object.fromEntries([...VERDICT_STATES, 'not_claude', 'other'].map(k => [k, k])) },
        fits_any: { type: 'noul', instructions: 'y' }, menu: { type: 'choice', instructions: 'z', criteria: Object.fromEntries(kinds.map(k => [k, k])) } } }))
    const ref: { s?: ScreenStatus } = {}
    const st = { program: prog('idle') }
    const jev = new JevJudge({ agent: 'lab-test', lanesDir: dir, hasKey: () => true, questionsPath: qp, logCall: () => {}, log: () => {}, program: () => st.program,
      ask: async (): Promise<JevAnswer> => ({ answers: { state: { choice: 'waiting_for_human', probabilities: { waiting_for_human: 0.95 } }, fits_any: { noul: 0.9 },
        menu: { choice: answer, probabilities: { [answer]: 0.97 } } }, ms: 5 }), published: p => ref.s ? ref.s.view(p) : p, holds: (h, v) => !!ref.s?.holds(h, v) }, { settleMs: 5 })
    const deps: ScreenDeps = { agent: 'lab-test', lanesDir: dir, switchOn: () => true, judge: () => jev, snap: async () => null, isClaude: c => c !== 'zsh',
      program: () => st.program, publish: () => {}, log: () => {} }
    const s = new ScreenStatus(deps, { retryMs: 30, activeCheckMs: 0 })
    ref.s = s; s.active()
    s.sample(lookTxt('refusal-fallback-2.txt', Date.now()))
    for (let i = 0; i < 50 && !s.health().answer; i++) await new Promise(r => setTimeout(r, 10))
    const v = s.view(st.program)
    rmSync(dir, { recursive: true, force: true })
    return v
  }
  const V7 = ['none', 'permission', 'model_picker', 'trust_folder', 'usage_limit_options', 'resume_picker', 'plan_or_question', 'login', 'other']
  test('v7 (kinds absent): Jev can only say other; the record names the refusal picker from the program\'s layout', async () => {
    expect(await jevRun(V7, 'other')).toMatchObject({ state: 'waiting', detail: { waitingFor: 'refusal_fallback', judged_by: 'jev' } })
  })
  test('v8 (kinds present): Jev\'s refusal_fallback is the record\'s', async () => {
    expect(await jevRun([...V7.slice(0, 8), 'refusal_fallback', 'switch_confirm', 'other'], 'refusal_fallback')).toMatchObject({ state: 'waiting', detail: { waitingFor: 'refusal_fallback', judged_by: 'jev' } })
  })
  test('a questions file newer than the daemon (a kind it does not know): the verdict stays, as other with menu_raw', async () => {
    const v = await jevRun([...V7, 'theme_picker'], 'theme_picker')
    expect(v).toMatchObject({ state: 'waiting', detail: { judged_by: 'jev', menu_raw: 'theme_picker' } })
  })
})

describe('the reader: one look, the record for exactly that look', () => {
  const rig = (judge: ScreenJudge | null) => {
    const st = { program: prog('idle') }
    const deps: ScreenDeps = { agent: 'lab-test', lanesDir: mkdtempSync(join(tmpdir(), 'wo168-r-')), switchOn: () => true, judge: () => judge, snap: async () => null,
      isClaude: c => c !== 'zsh', program: () => st.program, publish: () => {}, log: () => {} }
    const s = new ScreenStatus(deps, { retryMs: 30, activeCheckMs: 0 })
    s.active()
    return { s, st }
  }
  test('a look is sampled once (the reader\'s listener and the reader\'s own look are the same look)', () => {
    const { s } = rig(null)
    const l = lookOf('cc-02-idle', Date.now(), 7)
    s.sample(l); s.sample(l)
    expect(s.health()).toMatchObject({ looks: 1 })
    s.sample({ ...l, seq: 8 }); expect(s.health()).toMatchObject({ looks: 2 })
  })
  test('recordOf: the record for exactly the look given, never the verdict of another screen; the published record keeps the last verdict while a new screen is judged', async () => {
    let gate: (v: ScreenVerdict | null) => void = () => {}
    const judge: ScreenJudge = { name: 'fake', judge: async p => p.st.has_input_box ? V('idle') : new Promise(r => { gate = r }) }
    const { s, st } = rig(judge)
    s.sample(lookOf('cc-02-idle', Date.now(), 1))
    for (let i = 0; i < 20 && !s.health().answer; i++) await new Promise(r => setTimeout(r, 5))
    expect(s.view(st.program)).toMatchObject({ state: 'idle', detail: { judged_by: 'jev', input_typed: false } })
    const menu = lookOf('cc-05-model', Date.now(), 2)
    s.sample(menu)                                                                       // being judged now (gate held)
    expect(s.view(st.program)).toMatchObject({ state: 'idle', detail: { judged_by: 'jev' } })   // WO-169: the last verdict stands while judging
    const r = s.recordOf(menu, st.program)!
    expect(r.view).toMatchObject({ state: 'waiting', detail: { waitingFor: 'other', judged_by: 'program', screen: { hash: r.hash } } })   // this screen's own facts
    expect(r.hash).toBe(screenHash(regionParts(menu.visible)))
    gate(V('waiting_for_human', 'model_picker'))
    for (let i = 0; i < 20 && s.health().answer?.menu !== 'model_picker'; i++) await new Promise(r => setTimeout(r, 5))
    expect(s.recordOf(menu, st.program)!.view).toMatchObject({ state: 'waiting', detail: { waitingFor: 'model_picker', judged_by: 'jev' } })
    expect(s.recordOf(lookOf('cc-02-idle', Date.now(), 3), st.program)!.view).toMatchObject({ state: 'idle', detail: { judged_by: 'jev' } })   // its own cached verdict
  })
  test('JEV_SCREEN not listing the agent: no record of the screen (the reader\'s callers read the screen as before)', () => {
    const deps: ScreenDeps = { agent: 'lab-test', lanesDir: mkdtempSync(join(tmpdir(), 'wo168-off-')), switchOn: () => false, judge: () => null, snap: async () => null,
      isClaude: () => true, program: () => prog('idle'), publish: () => {}, log: () => {} }
    const s = new ScreenStatus(deps, { activeCheckMs: 0 }); s.active()
    expect(s.recordOf(lookOf('cc-05-model'), prog('idle'))).toBeNull()
  })
})

describe('pane-look.ts: the one capture', () => {
  test('splitVisible: the last pane_height rows are the visible part', () => {
    expect(splitVisible('h1\nh2\nv1\nv2\nv3\n', 3)).toEqual({ scrollback: 'h1\nh2', visible: 'v1\nv2\nv3' })
    expect(splitVisible('v1\nv2\n', 5)).toEqual({ scrollback: '', visible: 'v1\nv2' })
  })
  test('stripAnsi: SGR, OSC 8 hyperlinks (BEL or ST), charset switches', () => {
    expect(stripAnsi('\x1b[38;5;246m\x1b]8;id=a;https://x\x1b\\Security guide\x1b[39m\x1b]8;;\x1b\\ \x1b(Bok\x1b]8;;u\x07!\x1b]8;;\x07')).toBe('Security guide ok!')
  })
  test('PaneReader: callers at the same moment share one capture; fresh() reuses a recent look; every look reaches the listeners once', async () => {
    let n = 0, clock = 1000
    const r = new PaneReader('p', async () => { n++; await new Promise(x => setTimeout(x, 10)); return { cmd: 'claude', inMode: false, path: '/', visible: `v${n}`, visibleAnsi: `v${n}`, text: `v${n}` } }, () => clock)
    const heard: number[] = []
    r.onLook(l => { if (l) heard.push(l.seq) })
    const [a, b] = await Promise.all([r.look(), r.fresh(0)])
    expect(n).toBe(1); expect(a).toBe(b); expect(heard).toEqual([1])
    clock += 500
    expect(await r.fresh(1000)).toBe(a); expect(n).toBe(1)
    clock += 2000
    expect((await r.fresh(1000))!.seq).toBe(2); expect(n).toBe(2); expect(heard).toEqual([1, 2])
  })
  const HAS_TMUX = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0
  test.skipIf(!HAS_TMUX || !!process.env.TMUX)('snapPaneLook on a PRIVATE tmux server (-S, TMUX unset): one run, the visible rows, the scrollback, the escapes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wo168-tmux-')), sock = join(root, 'sock')
    if (!sock.startsWith(tmpdir())) throw new Error('refusing to run tmux outside the test socket')
    const env: Record<string, string> = { ...process.env as Record<string, string> }; delete env.TMUX; delete env.TMUX_PANE
    const t = (...a: string[]) => spawnSync('tmux', ['-S', sock, ...a], { encoding: 'utf8', env })
    try {
      const script = join(root, 'show.sh')
      writeFileSync(script, `for i in $(seq 1 30); do echo "old line $i"; done; printf '\\033[2mdim\\033[22m plain\\n'; exec sleep 3600\n`)
      expect(t('new-session', '-d', '-s', 'wo168', '-x', '80', '-y', '10', `sh ${script}`).status).toBe(0)
      await new Promise(r => setTimeout(r, 400))
      const l = await snapPaneLook('wo168', { socket: sock, scrollback: 60 })
      expect(l).not.toBeNull()
      expect(l!.visible.split('\n').length).toBe(10)
      expect(l!.visible).toContain('dim plain')
      expect(l!.visibleAnsi).toContain('\x1b[2m')
      expect(l!.text).toContain('old line 1\n')                                        // the scrollback came in the same run
      expect(l!.text.endsWith(l!.visible)).toBe(true)
      expect(l!.inMode).toBe(false)
    } finally { t('kill-server'); rmSync(root, { recursive: true, force: true }) }
  })
})

// WO-168 (Chiron #200727; sandwich-master 11-27 13:00:34Z, Onsen Action 393): the usage-limit line left under the prompt is no menu in the record either
import { composeRecord as compose168n, regionParts as parts168n, screenFacts as facts168n } from './screen-status.ts'
test('the usage-limit line under the prompt: a judge\'s 「waiting, other」 is not taken; the program\'s reading stands (in a turn: busy)', () => {
  const screen = ['     … +4 tasks (1 in progress, 1 open, 2 done)', '─'.repeat(80), '❯ ', '─'.repeat(80), '  ⚠ Usage limit reached · limit resets Dec 3 at 11pm',
    '    Continuing automatically at Dec 3 at 11pm · Esc to cancel · /usage-credits', '    to continue now', '  Fable 5.2 · 7d 12%',
    '  ⏵⏵ bypass permissions on · 3 shells · esc to interrupt · ctrl+t to hide tas…'].join('\n')
  const p = parts168n(screen)
  const f = facts168n(screen, screen, p.st)
  expect(f.usage_notice).toBe(true)
  const prog = { state: 'idle', detail: { queued_joey: 0 }, last_activity_at: null } as any
  const rec = compose168n({ state: 'waiting_for_human', menu: 'other', p: 0.9, by: 'jev' }, p.st, prog, { alive: true }, { hash: 'h', seen_at: 0, facts: f }).view
  expect(rec.state).not.toBe('waiting')
  expect((rec.detail as any)?.waitingFor).toBeUndefined()
})
