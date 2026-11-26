// WO-165 A: Jev reads the screen (screen-status.ts). Synthetic screens only (this repo is public); Chiron's real eval screens are checked when they are
// on this machine (~/cc-workspaces/claude-chiron/knowledge/tg-dialogue/screen-eval + labels.json), against his own jev_screen.py when python3 is there.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScreenStatus, VERDICT_MENUS, VERDICT_STATES, programView, publishView, regionParts, regions, screenHash, type ScreenDeps, type ScreenVerdict } from './screen-status.ts'
import { JevJudge, answerExceptions, decide, parseQuestions, readAnswers, verdictOf, type JevAnswer, type JevJudgeDeps } from './screen-judge-jev.ts'
import { jevAsk } from './lanes-triage.ts'
import type { StatusView } from './onsen-status.ts'

const R = '─'.repeat(80)
const screen = (above: string[], below: string[] = ['  Opus 5.5 · 7d 71%', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'], box = '❯ ') =>
  ['', ...above, '', R, box, R, ...below, '', ''].join('\n')
const BUSY = (glyph = '✳', paren = '(5m 4s · ↓ 24.2k tokens)') => screen([
  '⏺ Bash(ls -la)', '  ⎿  total 8', '', `${glyph} Cerebrating… ${paren}`, '  ⎿  Tip: Name your conversations with /rename to find them easily'])
const IDLE = screen(['⏺ Done: the report is written.', '', '✻ Worked for 17s · done 1:37 AM'])
const IDLE_SHELL = screen(['⏺ Started the build in the background.', '', '✻ Brewed for 28s · done 2:29 AM · 1 shell still running'],
  ['  Fable 5.2 · 7d 72%', '  ⏵⏵ bypass permissions on · 1 shell'])
const AGENT_LINE = (t: string) => `  ◯ general-purpose  Checking the test settings    ${t} · ↓ 236.4k tokens`
const BG_AGENTS = (t = '7m 45s') => screen(['⏺ Two helpers are on it.', '', '✻ Waiting for 2 background agents to finish'],
  ['  Opus 5.5 · 7d 72%', '  ⏵⏵ bypass permissions on · 1 shell', '', '  ⏺ main', AGENT_LINE(t), '  ◯ general-purpose  Reading the docs  1m 2s · ↓ 3.1k tokens'])
const MENU = (cursor = 5) => ['', '  print(n)"', '▔'.repeat(80), '   Select model', '   Switch between Claude models.',
  ...['Default (recommended)', 'Sonnet', 'Fable', 'Opus', 'Haiku'].map((m, i) => `   ${i + 1 === cursor ? '❯' : ' '} ${i + 1}. ${m}`),
  '   Enter to set as default · s to use this session only · Esc to cancel', ''].join('\n')
const BG_TASKS = screen(['⏺ The suite runs on the other machine.', '', '✻ Worked for 2m 3s · done 3:01 AM'],
  ['  Opus 5.5 · 7d 74%', '  ⏵⏵ bypass permissions on · 2 background tasks · ctrl+t to show tasks · ↓ to manage', '', '  ⏺ main',
    '  ◯ general-purpose  Running full test suite on txmon… 4m 3s · ↓ 12.0k tokens'])
const INTERRUPTED = screen(['✻ Churned for 6s · done 12:07 AM', '  Called plugin:telegram-http:telegram-http, ran 1 shell command', '  ⎿  Interrupted · What should Claude do instead?'])
const SHELL = '\nResume this session with:\nclaude --resume 76ebebd2-d899-497b-aa2b-300b404908fe\n\nuser@host:~/cc-workspaces/claude-lab$ \n'
const h = (t: string) => screenHash(regionParts(t))

describe('regions (port of jev_screen.py)', () => {
  test('input box: above (≤14), box, below; counts and facts', () => {
    const r = regions(BG_AGENTS())
    expect(r.has_input_box).toBe(true)
    expect(r.input_box).toBe('❯')
    expect(r.counted_by_program).toEqual({ running_agents: 2, shells: 1, monitors: 0, background_tasks: 0 })
    expect(r.found_by_program.live_activity_line).toBeNull()
    const b = regions(BUSY())
    expect(b.found_by_program).toEqual({ live_activity_line: '✳ Cerebrating… (5m 4s · ↓ 24.2k tokens)', limit_message_is_latest_output: null, interrupted_is_latest_output: null, finished_marker_comes_after_it: false, tool_running_line: false, esc_to_interrupt: false })
    expect(regions(IDLE_SHELL).counted_by_program).toEqual({ running_agents: 0, shells: 1, monitors: 0, background_tasks: 0 })
    // v3 (Chiron 19:21Z): the newer status line
    expect(regions(BG_TASKS).counted_by_program).toEqual({ running_agents: 1, shells: 0, monitors: 0, background_tasks: 2 })
    const long = screen(Array.from({ length: 30 }, (_, i) => `line ${i}`))
    expect(regions(long).above_input_box!.split('\n')).toHaveLength(14)
  })
  test('no input box (a menu): the last 18 lines', () => {
    const r = regions(MENU())
    expect(r.has_input_box).toBe(false)
    expect(r.screen_bottom!.split('\n').length).toBeLessThanOrEqual(18)
    expect(r.screen_bottom).toContain('Select model')
    expect(regions(SHELL).has_input_box).toBe(false)
  })
  test('a live activity line followed by a finished marker is not live', () => {
    const r = regions(screen(['· Thinking… (3s)', 'text', '✻ Worked for 9s · done 1:00 AM']))
    expect(r.found_by_program.live_activity_line).toBe('· Thinking… (3s)')
    expect(r.found_by_program.finished_marker_comes_after_it).toBe(true)
  })
  test('"Waiting for N background agents" counts only as the last marker line (Chiron 20:23Z: the old line stays after they finish)', () => {
    expect(regions(screen(['✻ Waiting for 2 background agents to finish'])).counted_by_program.running_agents).toBe(2)
    expect(regions(screen(['✻ Waiting for 1 background agent to finish', 'the agent reported back', '✻ Crunched for 2s · done 4:11 AM'])).counted_by_program.running_agents).toBe(0)
  })
  // questions v6 (JCS 0cd8920) and v7 (c17c1c0): cut_by_program / counted_by_program / found_by_program are what the program computes before the judge
  // (Chiron WO-169 01:47Z A)
  test('v6 cut: the effort hint on the row above the input box is interface text, dropped before the last 14 lines are taken', () => {
    const r = regions(screen([...Array.from({ length: 14 }, (_, i) => `line ${i}`), '                                                   ◐ medium · /effort']))
    expect(r.above_input_box!.split('\n')).toEqual(Array.from({ length: 14 }, (_, i) => `line ${i}`))
    expect(regions(screen(['⏺ It said ◐ medium · /effort in a sentence'])).above_input_box).toContain('/effort')     // not the hint: text around it
  })
  test('v6 counts: below the input box only; with no input box nothing is counted', () => {
    expect(regions(screen(['  Called plugin:telegram-http:telegram-http, ran 1 shell command', '✻ Worked for 3s · done 1:00 AM'])).counted_by_program.shells).toBe(0)
    expect(regions(['  Called x, ran 1 shell command', '  2 shells · 1 monitor', '   ❯ 1. Stop and wait for limit to reset', '   Enter to confirm · Esc to cancel'].join('\n'))
      .counted_by_program).toEqual({ running_agents: 0, shells: 0, monitors: 0, background_tasks: 0 })
  })
  test("v7 facts: limit_message_is_latest_output (null with no limit text; the finished marker right under it is its own turn's)", () => {
    const LIM = "  ⎿  You've hit your weekly limit · resets Dec 1, 9am"
    const fact = (above: string[]) => regions(screen(above)).found_by_program.limit_message_is_latest_output
    expect(fact(['⏺ Done.', '✻ Worked for 17s · done 1:37 AM'])).toBeNull()
    expect(fact(['❯ go on', LIM, '✻ Worked for 0s · done 1:37 AM'])).toBe(true)
    expect(fact(['❯ go on', LIM, '✻ Worked for 0s · done 1:37 AM', '❯ again', '● 。'])).toBe(false)              // the model replied after it
    expect(fact(['❯ go on', LIM, '❯ again', '✶ Thinking… (3s)'])).toBe(false)                                   // a turn is running after it
    expect(fact(['❯ go on', LIM, '❯ again', '✻ Worked for 12s · done 1:50 AM'])).toBe(false)                    // another turn finished after it
    expect(fact(['❯ /rate-limit-options', '  ⎿  Rate limit options dialog dismissed'])).toBe(true)
    expect(fact(['❯ go on', LIM, '✻ Worked for 0s · done 1:37 AM', '✻ Worked for 3s · done 1:38 AM'])).toBe(false)  // a second marker: another turn's
    expect(regions(screen(['❯ go on', LIM])).found_by_program).toEqual({ live_activity_line: null, limit_message_is_latest_output: true, interrupted_is_latest_output: null,
      finished_marker_comes_after_it: false, tool_running_line: false, esc_to_interrupt: false })                 // Chiron's key order: the JSON Jev reads
  })
  test('v7 facts: interrupted_is_latest_output (the same rule; a later slash command or incoming channel message also ends it)', () => {
    const CUT = '  ⎿  Interrupted · What should Claude do instead?'
    const fact = (above: string[]) => regions(screen(above)).found_by_program.interrupted_is_latest_output
    expect(fact(['⏺ Done.'])).toBeNull()
    expect(regions(INTERRUPTED).found_by_program.interrupted_is_latest_output).toBe(true)
    expect(fact(['⏺ Bash(sleep 60)', CUT, '✻ Churned for 6s · done 12:07 AM'])).toBe(true)                      // its own turn's marker
    expect(fact([CUT, '❯ /model', '  ⎿  Kept model as Haiku 5.5'])).toBe(false)
    expect(fact([CUT, '← telegram-http · awesometon5: 再試一次'])).toBe(false)
    expect(fact([CUT, '● 好，我接著做。'])).toBe(false)
    expect(fact([CUT, '✶ Thinking… (2s)'])).toBe(false)
  })
  const dir = join(homedir(), 'cc-workspaces', 'claude-chiron', 'knowledge', 'tg-dialogue')
  const evalDir = join(dir, 'screen-eval')
  test.skipIf(!existsSync(join(evalDir, 'labels.json')))("Chiron's eval screens: the program's counts match labels.json", () => {
    const labels = JSON.parse(readFileSync(join(evalDir, 'labels.json'), 'utf8')) as Record<string, { agents?: number; shells?: number }>
    let n = 0
    for (const [f, t] of Object.entries(labels)) {
      if (!existsSync(join(evalDir, f))) continue
      const c = regions(readFileSync(join(evalDir, f), 'utf8')).counted_by_program
      expect({ f, agents: c.running_agents, shells: c.shells }).toEqual({ f, agents: t.agents ?? 0, shells: t.shells ?? 0 })
      n++
    }
    expect(n).toBeGreaterThan(20)
  })
  const py = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0
  test.skipIf(!py || !existsSync(join(dir, 'jev_screen.py')) || !existsSync(evalDir))("Chiron's eval screens: identical to jev_screen.py regions()", () => {
    const prog = 'import json,os,sys,importlib.util\nspec=importlib.util.spec_from_file_location("js",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n' +
      'd=sys.argv[2];print(json.dumps({f:m.regions(open(os.path.join(d,f),encoding="utf-8").read()) for f in sorted(os.listdir(d)) if f.endswith(".txt")},ensure_ascii=False))'
    const r = spawnSync('python3', ['-I', '-c', prog, join(dir, 'jev_screen.py'), evalDir], { encoding: 'utf8', maxBuffer: 32 << 20 })
    expect(r.status).toBe(0)
    const want = JSON.parse(r.stdout) as Record<string, unknown>
    const files = readdirSync(evalDir).filter(f => f.endsWith('.txt'))
    expect(Object.keys(want).length).toBe(files.length)
    for (const f of files) expect({ f, r: regions(readFileSync(join(evalDir, f), 'utf8')) }).toEqual({ f, r: want[f] })
  })
  // Chiron's fixture (WO-169 01:47Z A): what each of his screens must hand the judge under the questions' current version (regions-v<N>.json, the
  // highest N; v6 01:46Z 63 screens, v7 02:03Z 64), field by field and in the same key order
  const fxFile = existsSync(evalDir) ? readdirSync(evalDir).filter(f => /^regions-v\d+\.json$/.test(f)).sort((a, b) => parseInt(a.slice(9), 10) - parseInt(b.slice(9), 10)).at(-1) : undefined
  test.skipIf(!fxFile)("Chiron's regions-v<N>.json: every screen gives exactly the fixture's regions", () => {
    const fx = JSON.parse(readFileSync(join(evalDir, fxFile!), 'utf8')) as { questions_version: number; regions: Record<string, unknown> }
    expect(fx.questions_version).toBe(parseInt(fxFile!.slice(9), 10))
    const names = Object.keys(fx.regions)
    expect(names.length).toBeGreaterThanOrEqual(63)
    for (const f of names) expect({ f, r: JSON.stringify(regions(readFileSync(join(evalDir, f), 'utf8'))) }).toEqual({ f, r: JSON.stringify(fx.regions[f]) })
  })
})

describe('screen hash: what changes every second is masked, a real change is not', () => {
  test('busy: spinner glyph, elapsed, tokens, thinking note', () => {
    const a = h(BUSY('✳', '(5m 4s · ↓ 24.2k tokens)'))
    for (const [g, p] of [['✶', '(5m 5s · ↓ 24.3k tokens)'], ['✻', '(5m 6s · ↓ 24.3k tokens · thinking with xhigh effort)'], ['·', '(5m 9s · thought for 3s)'], ['✽', '(1h 2m 3s)']])
      expect(h(BUSY(g, p))).toBe(a)
  })
  test("busy: the turn's output scrolling above the spinner", () => {
    const a = h(screen(['⏺ Bash(ls)', '  ⎿  a', '', '✳ Cerebrating… (5s)', '  ⎿  Tip: x']))
    expect(h(screen(['⏺ Read(file.ts)', '  ⎿  Read 40 lines', '⏺ Bash(ls)', '  ⎿  b', '', '✶ Cerebrating… (9s)', '  ⎿  Tip: x']))).toBe(a)
  })
  test('sub-agent timers and tokens, the status line percentages, typing in the box, a right-aligned notice', () => {
    expect(h(BG_AGENTS('7m 46s'))).toBe(h(BG_AGENTS('7m 45s')))
    const s = (pct: string, box = '❯ ', note: string[] = []) => screen(['✻ Worked for 17s · done 1:37 AM'], [`  Opus 5.5 · 7d ${pct}`, '  ⏵⏵ bypass permissions on (shift+tab to cycle)', ...note], box)
    expect(h(s('72%'))).toBe(h(s('71%')))
    expect(h(s('71%', '❯ please look at the build'))).toBe(h(s('71%')))
  })
  test("Chiron's list (19:23Z): above the box only its last 2 lines count; the activity line only by being there (its verb changes mid-turn)", () => {
    const busy = (out: string[], verb: string) => screen([...out, '', `✳ ${verb}… (5s · ↓ 1.0k tokens)`, '  ⎿  Tip: x'])
    const a = h(busy(['⏺ Bash(ls)', '  ⎿  a'], 'Cerebrating'))
    expect(h(busy(['⏺ Read(f.ts)', '  ⎿  Read 40 lines', '⏺ Bash(ls)', '  ⎿  b', '⏺ Now the tests.'], 'Burrowing'))).toBe(a)
    // a todo list under the activity line: its last 2 lines count (digits masked)
    const todo = (n: number) => screen(['✳ Working… (5s)', '  ⎿  ◼ step one', `      … +${n} in progress, 3 pending, 52 completed`])
    expect(h(todo(24))).toBe(h(todo(25)))
  })
  test('an activity line wrapped onto the next line; notices (right-aligned, the usage notice) above or below the box', () => {
    const wrap = (t: string[]) => screen(['⏺ Done with the edit.', ...t, '  ⎿  Tip: You have 29 plugins you haven\'t used lately.'])
    const a = h(wrap(['✻ Thinking through messages… (running Stop hooks… 2/5 · 1m 27s ·', '↓ 2.7k tokens)']))
    expect(h(wrap(['✢ Thinking through messages… (1m 39s · ↓ 3.1k tokens)']))).toBe(a)
    const idle = (above: string[], below: string[] = []) => screen(['⏺ Sent.', '✻ Worked for 9s · done 3:00 AM', ...above], ['  Opus 5.5 · 7d 79%', '  ⏵⏵ bypass permissions on', ...below])
    expect(h(idle(['                                             stop hook problem · ctrl+o to see']))).toBe(h(idle([])))
    expect(h(idle(['      You\'ve used 79% of your weekly limit · resets Dec 1 at 6am (Asia/Taipei)']))).toBe(h(idle([])))
    expect(h(idle([], ['                                      Stop hook error occurred · ctrl+o to see']))).toBe(h(idle([])))
  })
  test("a sub-agent row's live activity and its column alignment; a tool's Running… coming and going under a live activity line", () => {
    const sub = (desc: string, pad: string) => screen(['✻ Waiting for 1 background agent to finish'], ['  Opus 5.5 · 7d 72%', '  ⏵⏵ bypass permissions on', '', '  ⏺ main',
      `  ◯ general-purpose  ${desc}${pad}9m 59s · ↓ 1.2k tokens`])
    expect(h(sub('Waiting for mid-turn messages …', '  '))).toBe(h(sub('Running 3s mid-turn delivery …', ' ')))
    // a tool's Running… coming and going is in Chiron's list (two hashes; the answer cache asks each once)
    const run = (r: boolean) => screen(['⏺ Bash(sleep 5)', ...(r ? ['  ⎿  Running…'] : ['  ⎿  (No output)']), '', '✳ Cerebrating… (5s)', '  ⎿  Tip: x'])
    expect(h(run(true))).not.toBe(h(run(false)))
  })
  test('real changes count', () => {
    const all = [BUSY(), IDLE, IDLE_SHELL, BG_AGENTS(), MENU(5), MENU(4), INTERRUPTED, SHELL,
      screen(['⏺ Started the build in the background.', '', '✻ Brewed for 28s · done 2:29 AM · 2 shells still running'], ['  Fable 5.2 · 7d 72%', '  ⏵⏵ bypass permissions on · 2 shells']),
      screen(['⏺ Bash(ls)', '  ⎿  Running…', '', '✳ Cerebrating… (5s)']),
      screen(['✻ Compacting conversation… (12s)']), screen(['✻ Cerebrating… (12s)']), BG_TASKS,
      BG_TASKS.replace('2 background tasks', '3 background tasks'),
      screen(['✻ Worked for 17s · done 1:37 AM'], ['  Opus 5.5 · 7d 71%', '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt'])]
    expect(new Set(all.map(h)).size).toBe(all.length)
    // the same turn: a sub-agent appears under the box
    const one = BG_AGENTS(), lessAgents = one.replace(/\n {2}◯ general-purpose {2}Reading the docs[^\n]*/, '')
    expect(h(lessAgents)).not.toBe(h(one))
  })
})

describe('questions file', () => {
  const good = { version: 1, model: 'jev-1.14.0', setting: 'Text from a terminal.', publish_when_state_probability_at_least: 0.6,
    questions: { state: { type: 'choice', instructions: 'x', criteria: { working: 'a', idle: 'b', other: 'c' } }, fits_any: { type: 'noul', instructions: 'y' },
      menu: { type: 'choice', instructions: 'z', criteria: { none: 'n', other: 'o' } } } }
  test('the shape Chiron writes is read; anything else is not', () => {
    const q = parseQuestions(JSON.stringify(good), '/x')!
    expect(q.model).toBe('jev-1.14.0'); expect(q.threshold).toBe(0.6); expect(q.setting).toBe('Text from a terminal.'); expect(q.sha).toHaveLength(12)
    expect(q.menuRule).toBeNull()
    expect(parseQuestions(JSON.stringify({ ...good, if_menu_is_not_none_with_probability_at_least: 0.6, then_state: 'waiting_for_human' }), '/x')!.menuRule)
      .toEqual({ threshold: 0.6, state: 'waiting_for_human' })
    expect(parseQuestions('{', '/x')).toBeNull()
    expect(parseQuestions(JSON.stringify({ ...good, questions: { state: good.questions.state } }), '/x')).toBeNull()
    expect(parseQuestions(JSON.stringify({ ...good, publish_when_state_probability_at_least: 7 }), '/x')!.threshold).toBe(0.6)
  })
  const jcs = join(homedir(), 'Development', 'Joey-Crablabs-Skills', 'screen-status', 'questions.json')
  test.skipIf(!existsSync(jcs))("the JCS file parses; every verdict state and menu is one of its options (an option it has that the lists do not is an exception)", () => {
    const q = parseQuestions(readFileSync(jcs, 'utf8'), jcs)!
    expect(q).not.toBeNull()
    const opts = Object.keys(q.questions.state.criteria), menus = Object.keys(q.questions.menu.criteria)
    for (const m of VERDICT_STATES) expect(opts).toContain(m)
    // WO-168 item 6: refusal_fallback and switch_confirm are known to the daemon before Chiron publishes questions v8 (the file may not have them yet)
    for (const m of VERDICT_MENUS) if (m !== 'refusal_fallback' && m !== 'switch_confirm') expect(menus).toContain(m)
  })
})

const prog = (state: StatusView['state'], detail: Record<string, unknown> = {}): StatusView => ({ state, detail: { queued_joey: 0, ...detail }, last_activity_at: '2026-11-26T00:00:00.000Z' })
const ans = (state: string, p = 0.9, menu = 'none', fits = 0.9) => readAnswers({ state: { choice: state, confidence: p, probabilities: { [state]: p } }, fits_any: { noul: fits },
  menu: { choice: menu, probabilities: { [menu]: 0.8 } } })
const V = (state: ScreenVerdict['state'], p = 0.9, menu: ScreenVerdict['menu'] = 'none', by: ScreenVerdict['by'] = 'jev'): ScreenVerdict => ({ state, menu, p, by })
describe('publish mapping (point 5; WO-169: from a ScreenVerdict)', () => {
  const st = regions(BG_AGENTS())
  test('each state', () => {
    const turn = { turn_started_at: '2026-11-26T00:00:01.000Z', tool: { name: 'Bash', since: '2026-11-26T00:00:02.000Z' }, subagents: 0 }
    expect(publishView(V('working', 0.91), st, prog('busy', turn))).toEqual({ state: 'busy', detail: { turn_started_at: turn.turn_started_at, tool: turn.tool, subagents: 2,
      queued_joey: 0, judged_by: 'jev', judge_p: 0.91 }, last_activity_at: '2026-11-26T00:00:00.000Z' })
    expect(publishView(V('working'), st, prog('idle')).detail).toEqual({ subagents: 2, queued_joey: 0, judged_by: 'jev', judge_p: 0.9 })
    expect(publishView(V('idle'), st, prog('busy', turn))).toMatchObject({ state: 'idle', detail: { queued_joey: 0, judged_by: 'jev' } })
    expect(publishView(V('idle'), st, prog('busy', turn)).detail).not.toHaveProperty('tool')
    expect(publishView(V('idle_background_running'), st, prog('idle'))).toMatchObject({ state: 'idle', detail: { background: { agents: 2, shells: 1, monitors: 0, tasks: 0 } } })
    expect(publishView(V('idle_background_running'), regions(BG_TASKS), prog('idle')).detail!.background).toEqual({ agents: 1, shells: 0, monitors: 0, tasks: 2 })
    expect(publishView(V('waiting_for_human', 0.8, 'model_picker'), regions(MENU()), prog('waiting', { waitingFor: 'dialog open' }))).toMatchObject({ state: 'waiting', detail: { waitingFor: 'model_picker', judged_by: 'jev' } })
    const other = publishView(V('waiting_for_human', 0.8, 'other'), regions(MENU()), prog('waiting'))
    expect(other.detail!.waitingFor).toBe('other'); expect(String(other.detail!.waiting_text)).toContain('Select model')
    expect(publishView(V('interrupted'), st, prog('idle'))).toMatchObject({ state: 'idle', detail: { interrupted: true } })
    expect(publishView(V('usage_limit'), st, prog('busy', { walled: { until: '2026-11-26T03:00:00.000Z', kind: 'session' } })))
      .toMatchObject({ state: 'walled', detail: { walled: { until: '2026-11-26T03:00:00.000Z', kind: 'session' }, judged_by: 'jev' } })
    expect(publishView(V('usage_limit'), st, prog('idle'))).toMatchObject({ state: 'walled', detail: { walled: { until: null } } })
    expect(publishView(V('compacting'), st, prog('busy'))).toMatchObject({ state: 'busy', detail: { compacting: true } })
    expect(publishView(V('starting'), st, prog('offline'))).toMatchObject({ state: 'starting', detail: { judged_by: 'jev' } })
    // an option no list has is no verdict (JevJudge's collection): the record is statusOf's
    expect(verdictOf(ans('not_claude'), 0.6)).toBeNull()
    expect(programView(prog('idle'))).toMatchObject({ state: 'idle', detail: { judged_by: 'program' } })
  })
})

describe('exceptions an answer shows by itself (point 6)', () => {
  const none = regions(IDLE), bg = regions(IDLE_SHELL)
  test('each trigger', () => {
    expect(answerExceptions(ans('idle'), none, 0.6)).toEqual([])
    expect(answerExceptions(ans('other'), none, 0.6)).toContain('state_other')
    expect(answerExceptions(ans('waiting_for_human', 0.9, 'other'), none, 0.6)).toContain('menu_other')
    expect(answerExceptions(ans('idle', 0.55), none, 0.6)).toEqual(['state_p_low'])
    expect(answerExceptions(ans('idle', 0.9, 'none', 0.4), none, 0.6)).toEqual(['fits_any_low'])
    expect(answerExceptions(ans('idle_background_running'), none, 0.6)).toEqual(['jev_background_program_none'])
    expect(answerExceptions(ans('idle'), bg, 0.6)).toEqual(['program_background_jev_idle'])
    expect(answerExceptions(ans('not_claude'), none, 0.6)).toEqual(['state_unmapped:not_claude'])
    expect(answerExceptions(ans('idle'), regions(BG_TASKS), 0.6)).toEqual(['program_background_jev_idle'])          // background tasks count
  })
  test("the menu rule (v2, Chiron 18:40Z): a menu other than none with p ≥ the file's threshold makes the state the file's then_state", () => {
    const rule = { menuRule: { threshold: 0.6, state: 'waiting_for_human' } }
    const d = decide(readAnswers({ state: { choice: 'starting', probabilities: { starting: 0.7 } }, menu: { choice: 'resume_picker', probabilities: { resume_picker: 0.8 } }, fits_any: { noul: 0.9 } }), rule)
    expect(d).toMatchObject({ state: 'waiting_for_human', p: 0.8, menu: 'resume_picker', by_menu: { state: 'starting', p: 0.7 } })
    expect(answerExceptions(d, regions(MENU()), 0.6)).toEqual(['menu_overrode_state:starting'])
    expect(publishView(verdictOf(d, 0.6)!, regions(MENU()), prog('idle'))).toMatchObject({ state: 'waiting', detail: { waitingFor: 'resume_picker', judge_p: 0.8 } })
    const low = readAnswers({ state: { choice: 'idle', probabilities: { idle: 0.9 } }, menu: { choice: 'model_picker', probabilities: { model_picker: 0.5 } } })
    expect(decide(low, rule).state).toBe('idle')
    const none = readAnswers({ state: { choice: 'idle', probabilities: { idle: 0.9 } }, menu: { choice: 'none', probabilities: { none: 0.99 } } })
    expect(decide(none, rule)).toBe(none)
    expect(decide(readAnswers({ state: { choice: 'idle', probabilities: { idle: 0.9 } }, menu: { choice: 'login', probabilities: { login: 0.9 } } }), { menuRule: null }).state).toBe('idle')
  })
})

// ------------------------------------------------------------------ the reader, with fakes (WO-169: the reader with a JevJudge)
type Rig = { s: ScreenStatus; judge: JevJudge; calls: Array<{ state: any; model: string | null }>; logs: any[]; published: number; dir: string
  pane: { text: string; cmd: string }; program: StatusView; resolve: Array<(a: JevAnswer) => void>; exceptions: () => any[]; deps: ScreenDeps; jdeps: JevJudgeDeps }
function rig(o: { answer?: (state: any) => JevAnswer | null; opts?: Record<string, any>; switchOn?: () => boolean; questions?: string | null } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'screen-status-'))
  const qp = join(dir, 'questions.json')
  if (o.questions !== null) writeFileSync(qp, o.questions ?? JSON.stringify({
    version: 1, model: 'jev-1.14.0', setting: 'S', publish_when_state_probability_at_least: 0.6,
    questions: { state: { type: 'choice', instructions: 'x', criteria: { working: 'a', idle: 'b', other: 'c' } }, fits_any: { type: 'noul', instructions: 'y' },
      menu: { type: 'choice', instructions: 'z', criteria: { none: 'n', other: 'o' } } } }))
  const r: Rig = { s: null as any, judge: null as any, calls: [], logs: [], published: 0, dir, pane: { text: IDLE, cmd: '2.1.322' }, program: prog('idle'), resolve: [],
    deps: null as any, jdeps: null as any,
    exceptions: () => { try { return readFileSync(join(dir, 'run', 'screen-exceptions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } } }
  r.jdeps = {
    agent: 'lab-test', lanesDir: dir, hasKey: () => true, questionsPath: qp,
    ask: (state, _q, _t, model) => {
      r.calls.push({ state, model })
      const a = o.answer?.(state)
      return a ? Promise.resolve(a) : new Promise(res => r.resolve.push(res))
    },
    logCall: rec => r.logs.push(rec), log: () => {}, program: () => r.program, published: p => r.s.view(p), holds: (h, v) => r.s.holds(h, v),
  }
  const { settleMs = 5, backoffMs = 50, ...ropts } = o.opts ?? {}
  r.judge = new JevJudge(r.jdeps, { settleMs, backoffMs })
  r.deps = {
    agent: 'lab-test', lanesDir: dir, switchOn: o.switchOn ?? (() => true), judge: () => r.judge,
    snap: async () => ({ cmd: r.pane.cmd, pane: r.pane.text }), isClaude: c => c !== 'zsh', program: () => r.program, publish: () => { r.published++ }, log: () => {},
  }
  r.s = new ScreenStatus(r.deps, { retryMs: 30, ...ropts })
  return r
}
const jevIdle = (p = 0.9): JevAnswer => ({ answers: { state: { choice: 'idle', confidence: p, probabilities: { idle: p, working: 1 - p } }, fits_any: { noul: 0.95 },
  menu: { choice: 'none', probabilities: { none: 0.97 } } }, ms: 190, usage: { input_tokens: 2400, output_tokens: 40 }, model: 'jev-1.14.0' })
const jevSays = (state: string, p = 0.9, menu = 'none'): JevAnswer => ({ answers: { state: { choice: state, confidence: p, probabilities: { [state]: p } }, fits_any: { noul: 0.95 },
  menu: { choice: menu, probabilities: { [menu]: 0.9 } } }, ms: 190, usage: { input_tokens: 2400 }, model: 'jev-1.14.0' })
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('the reader', () => {
  test('asked only when the hash changes; facts go as state; every call logged with its usage', async () => {
    const r = rig({ answer: () => jevIdle() })
    expect(r.s.active()).toBe(true)
    for (let i = 0; i < 10; i++) { r.s.sample(r.pane.text, r.pane.cmd); await wait(1) }
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]!.model).toBe('jev-1.14.0')
    expect(r.calls[0]!.state).toMatchObject({ setting: 'S', has_input_box: true, claude_process_alive: true, counted_by_program: { running_agents: 0, shells: 0, monitors: 0, background_tasks: 0 } })
    expect(r.logs[0]).toMatchObject({ site: 'screen-status', p: 0.9, ms: 190, usage: { input_tokens: 2400 }, err: null })
    expect(r.s.view(r.program)).toMatchObject({ state: 'idle', detail: { judged_by: 'jev', judge_p: 0.9 } })
    // the spinner moving is not a change
    r.pane.text = BUSY('✳'); r.s.sample(r.pane.text, r.pane.cmd); await wait(1)
    r.pane.text = BUSY('✶', '(5m 6s · ↓ 25.0k tokens)'); r.s.sample(r.pane.text, r.pane.cmd); await wait(1)
    expect(r.calls).toHaveLength(2)
  })
  test('one call in flight; changes while it flies are asked once, for the latest screen (coalesced, never queued)', async () => {
    const r = rig()
    r.s.active()
    r.s.sample(IDLE, '2.1.322')
    r.s.sample(BUSY(), '2.1.322')
    r.s.sample(IDLE_SHELL, '2.1.322')
    r.s.sample(BG_AGENTS(), '2.1.322')
    expect(r.calls).toHaveLength(1)
    expect(r.s.health().in_flight).toBe(true)
    r.resolve.shift()!(jevIdle()); await wait(2)
    expect(r.calls).toHaveLength(2)
    expect(r.calls[1]!.state.counted_by_program).toEqual({ running_agents: 2, shells: 1, monitors: 0, background_tasks: 0 })   // the latest screen, not the ones in between
    r.resolve.shift()!(jevSays('idle_background_running')); await wait(2)
    expect(r.calls).toHaveLength(2)
    expect(r.s.view(r.program)).toMatchObject({ state: 'idle', detail: { background: { agents: 2, shells: 1, monitors: 0 }, judged_by: 'jev' } })
  })
  test('60 s after the last ask (refreshMs here), any change of the screen is asked again, even with the same hash; an unchanged screen is not', async () => {
    const r = rig({ answer: () => jevSays('working'), opts: { refreshMs: 60 } })
    r.s.active()
    r.s.sample(BUSY('✳', '(5m 4s)'), '2.1.322'); await wait(2)
    r.s.sample(BUSY('✶', '(5m 5s)'), '2.1.322'); await wait(2)
    expect(r.calls).toHaveLength(1)                                               // same hash, within the minute
    await wait(70)
    r.s.sample(BUSY('✳', '(5m 4s)'), '2.1.322'); await wait(2)
    expect(r.calls).toHaveLength(1)                                               // the text is the one last asked about
    r.s.sample(BUSY('✻', '(6m 1s)'), '2.1.322'); await wait(2)
    expect(r.calls).toHaveLength(2)
    expect(r.s.health().refreshes).toBe(1)
    r.s.sample(BUSY('·', '(6m 2s)'), '2.1.322'); await wait(2)
    expect(r.calls).toHaveLength(2)                                               // the next minute has not passed
  })
  test("the menu rule in the reader: Jev's state says idle, its menu says a model picker with p 0.8 → waiting, the menu kind, and an exception", async () => {
    const r = rig({ answer: () => ({ answers: { state: { choice: 'idle', probabilities: { idle: 0.9 } }, fits_any: { noul: 0.9 }, menu: { choice: 'model_picker', probabilities: { model_picker: 0.8 } } }, ms: 5 }),
      questions: JSON.stringify({ version: 2, model: 'jev-1.14.0', setting: 'S', publish_when_state_probability_at_least: 0.6, if_menu_is_not_none_with_probability_at_least: 0.6,
        then_state: 'waiting_for_human', questions: { state: { type: 'choice', instructions: 'x', criteria: { idle: 'b', waiting_for_human: 'w', other: 'c' } },
          fits_any: { type: 'noul', instructions: 'y' }, menu: { type: 'choice', instructions: 'z', criteria: { none: 'n', model_picker: 'm', other: 'o' } } } }) })
    r.s.active()
    r.program = prog('waiting', { waitingFor: 'dialog open' })
    r.s.sample(MENU(), '2.1.322'); await wait(20)
    expect(r.s.view(r.program)).toMatchObject({ state: 'waiting', detail: { waitingFor: 'model_picker', judge_p: 0.8, judged_by: 'jev' } })
    const ex = r.exceptions()
    expect(ex.map(e => e.kinds)).toEqual([['menu_overrode_state:idle']])
    expect(ex[0].jev).toMatchObject({ state: 'waiting_for_human', set_by_menu_rule: true, state_question: { state: 'idle', p: 0.9 } })
  })
  test('the cap per minute', async () => {
    const r = rig({ answer: () => jevIdle(), opts: { maxPerMin: 3 } })
    r.s.active()
    const screens = [IDLE, BUSY(), IDLE_SHELL, BG_AGENTS(), INTERRUPTED]
    for (const t of screens) { r.s.sample(t, '2.1.322'); await wait(1) }
    expect(r.calls).toHaveLength(3)
    expect(r.s.health().capped).toBeGreaterThan(0)
    expect(r.s.view(r.program).detail!.judged_by).toBe('program')             // the screen showing now was not judged
  })
  test('p below the threshold, a failed call: statusOf with judged_by program, and an exception line with the screen', async () => {
    const r = rig({ answer: s => s.counted_by_program.shells ? { error: 'TimeoutError: timed out', ms: 3000 } : jevIdle(0.5) })
    r.s.active()
    r.s.sample(IDLE, '2.1.322'); await wait(15)
    expect(r.s.view(r.program)).toEqual({ ...r.program, detail: { ...r.program.detail, judged_by: 'program' } })
    r.s.sample(IDLE_SHELL, '2.1.322'); await wait(15)
    expect(r.s.view(r.program).detail!.judged_by).toBe('program')
    const ex = r.exceptions()
    expect(ex.map(e => e.kinds)).toEqual([['state_p_low'], ['call_failed']])
    expect(ex[0].screen.above_input_box).toContain('Worked for 17s')
    expect(ex[0].jev).toMatchObject({ state: 'idle', state_p: 0.5 })
    expect(ex[0].program).toMatchObject({ state: 'idle' })
    expect(ex[1].jev.error).toContain('timed out')
    // a failed screen is asked once more after retryMs, then only every refreshMs (WO-169 criterion 13: 60 s here, not within the next 35 ms)
    r.s.sample(IDLE_SHELL, '2.1.322'); expect(r.calls).toHaveLength(2)
    await wait(35); r.s.sample(IDLE_SHELL, '2.1.322'); await wait(2); expect(r.calls).toHaveLength(3)
    await wait(35); r.s.sample(IDLE_SHELL, '2.1.322'); await wait(2); expect(r.calls).toHaveLength(3)
  })
  test('429: a pause before the next call', async () => {
    let n = 0
    const r = rig({ answer: () => (n++ === 0 ? { error: 'Error: HTTP 429, no answers', ms: 20 } : jevIdle()) })
    r.s.active()
    r.s.sample(IDLE, '2.1.322'); await wait(2)
    r.s.sample(BUSY(), '2.1.322'); await wait(2)
    expect(r.calls).toHaveLength(1)
    await wait(110); r.s.sample(BUSY(), '2.1.322'); await wait(2)             // backoffMs 50, jittered up to ×2
    expect(r.calls).toHaveLength(2)
  })
  test('a screen seen again a moment later (a flicker) takes its earlier answer', async () => {
    const r = rig({ answer: s => s.counted_by_program.shells ? jevSays('idle_background_running') : jevIdle() })
    r.s.active()
    for (let i = 0; i < 4; i++) { r.s.sample(IDLE, '2.1.322'); await wait(2); r.s.sample(IDLE_SHELL, '2.1.322'); await wait(2) }
    expect(r.calls).toHaveLength(2)
    expect(r.s.health().cache_hits).toBe(6)
    expect(r.s.view(r.program)).toMatchObject({ state: 'idle', detail: { background: { shells: 1 }, judged_by: 'jev' } })
  })
  test('Jev differs from statusOf: one exception, written once the screen held; an unknown menu: one exception with its text', async () => {
    const r = rig({ answer: s => s.has_input_box ? jevSays('working') : jevSays('waiting_for_human', 0.7, 'other') })
    r.s.active()
    r.s.sample(BUSY(), '2.1.322'); await wait(20)
    expect(r.exceptions().map(e => e.kinds)).toEqual([['differs_from_program']])
    expect(r.s.view(r.program).state).toBe('busy')
    r.program = prog('waiting', { waitingFor: 'dialog open' })
    r.s.sample(MENU(), '2.1.322'); await wait(20)
    const ex = r.exceptions()
    expect(ex).toHaveLength(2)
    expect(ex[1].kinds).toEqual(['menu_other'])
    expect(ex[1].screen.screen_bottom).toContain('Select model')
    expect(r.s.view(r.program)).toMatchObject({ state: 'waiting', detail: { waitingFor: 'other', judged_by: 'jev' } })
    // the screen moved on before the comparison: no comparison
    r.program = prog('idle')
    r.s.sample(BUSY(), '2.1.322'); r.s.sample(IDLE, '2.1.322'); await wait(30)
    // BUSY's answer came back with IDLE showing: not compared; IDLE (answered `working` by this fake): WO-177 ③, no activity fact on that screen → no
    // verdict (contradicts_program), nothing to compare
    expect(r.exceptions().filter(e => e.kinds.includes('differs_from_program'))).toHaveLength(1)
    expect(r.exceptions().filter(e => e.kinds.includes('contradicts_program'))).toHaveLength(1)
  })
  test('starting: statusOf offline (no registration / no stream yet) while Claude Code runs in the pane → asked; its reason stays in the detail', async () => {
    const r = rig({ answer: () => jevSays('starting', 0.8) })
    r.s.active()
    r.program = prog('offline', { reason: 'not_connected' })
    r.s.sample(MENU(), '2.1.322'); await wait(2)
    expect(r.calls).toHaveLength(1)
    expect(r.s.view(r.program)).toMatchObject({ state: 'starting', detail: { program_offline: 'not_connected', judged_by: 'jev' } })
  })
  test('not asked: the process is gone (statusOf offline pid_gone), or the pane runs a shell', async () => {
    const r = rig({ answer: () => jevIdle() })
    r.s.active()
    r.program = prog('offline', { reason: 'pid_gone' })
    r.s.sample(SHELL, '2.1.322'); await wait(2)
    expect(r.calls).toHaveLength(0)
    expect(r.s.view(r.program)).toMatchObject({ state: 'offline', detail: { reason: 'pid_gone', judged_by: 'program' } })
    r.program = prog('idle')
    r.s.sample(SHELL, 'zsh'); await wait(2)
    expect(r.calls).toHaveLength(0)
    expect(r.s.view(r.program).detail!.judged_by).toBe('program')
  })
  test('off: the switch, the key or the questions file missing → statusOf untouched (no judged_by), nothing looked at or asked', async () => {
    let on = false
    const r = rig({ answer: () => jevIdle(), switchOn: () => on, opts: { activeCheckMs: 0 } })
    expect(r.s.active()).toBe(false)
    r.s.sample(IDLE, '2.1.322'); await r.s.lookNow(); await wait(2)
    expect(r.calls).toHaveLength(0)
    expect(r.s.view(r.program)).toBe(r.program)
    on = true; expect(r.s.active()).toBe(true)
    r.s.sample(IDLE, '2.1.322'); await wait(2); expect(r.calls).toHaveLength(1)
    on = false; expect(r.s.active()).toBe(false)
    expect(r.s.view(r.program)).toBe(r.program)
    const nq = rig({ answer: () => jevIdle(), questions: null })
    expect(nq.s.active()).toBe(false)
  })
  test("an event of statusOf's view makes it look at once (twice), not its heartbeat or last_activity_at", async () => {
    let looks = 0
    const r = rig({ answer: () => jevIdle(), opts: { pokeMs: [1, 5] as any } })
    r.deps.snap = async () => { looks++; return { cmd: '2.1.322', pane: IDLE } }
    r.s.active()
    r.s.programChanged(prog('idle')); r.s.programChanged({ ...prog('idle'), last_activity_at: 'later' }); await wait(15)
    expect(looks).toBe(0)
    r.s.programChanged(prog('busy')); await wait(15)
    expect(looks).toBe(2)
  })
})

describe('jevAsk: the model to send and the usage it answers with', () => {
  test('sent model and returned usage', async () => {
    const was = { f: globalThis.fetch, k: process.env.TYPESAFE_API_KEY }
    let body: any = null
    globalThis.fetch = (async (_u: any, init: any) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ model: 'jev-1.14.0',
      answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 357, output_tokens: 38 } }), { status: 200 }) }) as any
    process.env.TYPESAFE_API_KEY = 'test-key-not-real'
    try {
      const dir = mkdtempSync(join(tmpdir(), 'jevask-'))
      const r = await jevAsk({ a: 1 }, { q: { type: 'noul', instructions: 'x' } }, 'test/1', 1000, { dir, site: 'unit' }, 'jev-1.13.0')
      expect(body.model).toBe('jev-1.13.0')
      expect(r).toMatchObject({ usage: { input_tokens: 357, output_tokens: 38 }, model: 'jev-1.14.0' })
      const line = JSON.parse(readFileSync(join(dir, 'run', 'jev-calls.jsonl'), 'utf8').trim())
      expect(line).toMatchObject({ site: 'unit', usage: { input_tokens: 357, output_tokens: 38 }, model: 'jev-1.14.0' })
      await jevAsk({ a: 1 }, { q: { type: 'noul', instructions: 'x' } }, 'test/1', 1000)
      expect(body.model).toBe(process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-1.14.0')
    } finally {
      globalThis.fetch = was.f
      if (was.k === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = was.k
    }
  })
})

describe("the duty officer's looks feed the reader", () => {
  test('onLook gets every look of a pane', async () => {
    const { DutyOfficer } = await import('./duty-officer.ts')
    const seen: Array<[string, string, string]> = []
    const tmux = { capture: async () => IDLE, info: async () => ({ cmd: '2.1.322', inMode: false, path: '/x' }), clientActivity: async () => null,
      sendKey: async () => {}, cancelMode: async () => {} }
    const d = new DutyOfficer({ listTargets: async () => [], tmux, model: async () => ({ decision: null, meta: {}, fail: 'x' }), send: async () => [], edit: async () => {},
      mail: async () => '', recipients: () => [], log: () => {}, onLook: (t, c, p) => seen.push([t, c, p]) }, { dir: mkdtempSync(join(tmpdir(), 'do-')) })
    const lk = await d.look('claude-lab-test')
    expect(lk?.state).toBe('IDLE')
    expect(seen).toEqual([['claude-lab-test', '2.1.322', IDLE]])
  })
})
