// WO-97 gap (Chiron 11-26 07:46Z; claude-kot 07:18Z, ask 67ecdc67): the duty officer pressed Enter on a typed /clear, looked once 2 s later, saw the same
// screen and told Joey 「畫面沒變」; the /clear ran its start hooks and the screen changed 13 s after the Enter. Now:
//   1. after the keys the screen is looked at until it changes, up to 15 s (DEFAULT_LIMITS.changeWaitMs), not once at 2 s
//   2. still the same screen: the same keys once more and the same wait; only then is it unchanged (and only then is a person asked)
//   3. Joey's tap: the sentence back to him is written after that wait, never 「畫面沒變」 first
// The pane changes on the officer's own clock (the fake sleep moves it), so the 13 s are the real number from kot's log. No tmux.
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LIMITS, DutyOfficer, type Decision, type ModelResult, type OfficerDeps, type PaneInfo, type Tmux } from './duty-officer.ts'

// the 11-22 / 11-26 screen: /clear typed, its completion list open under the box, the footer pushed out of the last lines
const TYPED = ['✻ Worked for 3s · done 3:18 PM', '────────────────────────────────────────', '❯ /clear', '────────────────────────────────────────',
  '  ❯ /clear                          Start a new session with empty context;', '                                    previous session stays on disk (resumable…',
  '    /compact                        Clear conversation history but keep a summary', '    /config                         Open config panel',
  '    /context                        Visualize current context usage', '    /cost                           Show the total cost and duration',
  '    /doctor                         Diagnose and verify your installation', '    /exit                           Exit the REPL'].join('\n')
const CLEARED = ['────────────────────────────────────────', '❯ ', '────────────────────────────────────────', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
const T0 = Date.parse('2026-11-26T07:18:00Z')
const decision = (over: Partial<Decision> = {}): Decision => ({ what: '輸入框打好 /clear 沒送出', why_now: '補全選單開著', if_nobody_answers: '一直停著', covered_by: '裁決簿第 2 條',
  action: 'do', choose: '送出', reason: '照打好的送出', to_joey: '', unsure: [],
  options: [{ on_screen: '❯ /clear', means: '送出 /clear', button: '送出', keys: ['Enter'] }, { on_screen: '(Esc)', means: '取消', button: '不送', keys: ['Esc'] }], ...over })

/** `changeAfterEnters`: the Enter (1st, 2nd) after which the screen starts to change, and how long after it (ms) it shows; null: never */
function rig(o: { changeAfter?: { enter: number; ms: number } | null; model?: () => ModelResult } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'do97-')), rules = mkdtempSync(join(tmpdir(), 'do97-rules-'))
  writeFileSync(join(rules, 'aide_prompt.md'), 'SYSTEM'); writeFileSync(join(rules, 'rulings.md'), 'RULINGS')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: ['claude-kot'] }))
  let clock = T0, enters = 0, changesAt: number | null = null
  const keys: string[] = [], sent: Array<{ text: string; buttons: any }> = [], edits: string[] = []
  const screen = () => changesAt != null && clock >= changesAt ? CLEARED : TYPED
  const tmux: Tmux = { capture: async () => screen(), clientActivity: async () => null, info: async (): Promise<PaneInfo> => ({ cmd: '2.1.322', inMode: false, path: '/nowhere' }),
    sendKey: async (_t, k) => { keys.push(k); if (k === 'Enter' && ++enters === o.changeAfter?.enter && changesAt == null) changesAt = clock + o.changeAfter.ms }, cancelMode: async () => {} }
  const deps: OfficerDeps = { listTargets: async () => [{ label: 'claude-kot', tmux: 'claude-kot', projectsDir: null }], tmux,
    model: async () => o.model ? o.model() : { decision: decision(), meta: {}, fail: null },
    send: async (_c, text, buttons) => { sent.push({ text, buttons }); return [{ chat: '1828173984', msg: 100 + sent.length }] }, edit: async (_s, text) => { edits.push(text) },
    mail: async () => '#1', recipients: () => ['1828173984'], log: () => {}, now: () => clock, sleep: async ms => { clock += ms } }
  const off = new DutyOfficer(deps, { dir, rulesDirs: [rules], home: dir, host: 'mini', limits: { claimFreshMs: 30_000 } })
  const settle = async () => { for (let i = 0; i < 60; i++) await new Promise(r => setTimeout(r, 0)) }
  const advance = async (ms: number) => { clock += ms; await off.tick(); await settle() }
  const log = () => readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  return { off, keys, sent, edits, advance, settle, log, clock: () => clock }
}

test('the numbers: 15 s of looking after the keys, one look a second, the first at 2 s', () => {
  expect(DEFAULT_LIMITS.changeWaitMs).toBe(15_000); expect(DEFAULT_LIMITS.changePollMs).toBe(1000); expect(DEFAULT_LIMITS.verifyAfterMs).toBe(2000)
})

test('kot 07:22Z: the screen changes 13 s after the Enter: the officer waits for it, says it went on, asks nobody, sends no second Enter', async () => {
  const r = rig({ changeAfter: { enter: 1, ms: 13_000 } })
  await r.advance(0); await r.advance(9000)
  expect(r.keys).toEqual(['Enter'])
  const p = r.log().find(e => e.event === 'pressed')
  expect(p).toMatchObject({ resolved: true, after_state: 'IDLE' })
  expect(p.waited_s).toBeGreaterThanOrEqual(13); expect(p.waited_s).toBeLessThanOrEqual(15)
  expect(p.retried).toBeUndefined()
  expect(r.sent).toEqual([])
})

test('the first Enter only picks the completion: no change in 15 s, the same key once more, and that one takes; nobody asked', async () => {
  const r = rig({ changeAfter: { enter: 2, ms: 3000 } })
  await r.advance(0); await r.advance(9000)
  expect(r.keys).toEqual(['Enter', 'Enter'])
  expect(r.log().find(e => e.event === 'pressed')).toMatchObject({ resolved: true, retried: true })
  expect(r.sent).toEqual([])
})

test('no change after the second press and 15 s more: only then is Joey asked, and the message says what was tried', async () => {
  const r = rig({ changeAfter: null })
  await r.advance(0); await r.advance(9000)
  expect(r.keys).toEqual(['Enter', 'Enter'])
  expect(r.log().find(e => e.event === 'pressed')).toMatchObject({ resolved: false, retried: true })
  expect(r.sent.length).toBe(1)
  expect(r.sent[0]!.text).toContain('我先按了 Enter，畫面沒變又按了一次')
  expect(r.log().find(e => e.event === 'notified')).toBeTruthy()
})

test('Joey\'s tap: the sentence back to him waits for the screen; a change 13 s after his Enter is 「畫面已經往下走」, not 「畫面沒變」', async () => {
  const r = rig({ changeAfter: { enter: 1, ms: 13_000 }, model: () => ({ decision: decision({ action: 'ask_joey', to_joey: 'claude-kot 輸入框打好 /clear，要送出嗎？' }), meta: {}, fail: null }) })
  await r.advance(0); await r.advance(9000)
  expect(r.keys).toEqual([]); expect(r.sent.length).toBe(1)
  const res = await r.off.onTap(r.sent[0]!.buttons[0][0].callback_data, 'Advac777')
  expect(res).toBe('按了，畫面已經往下走')
  expect(r.keys).toEqual(['Enter'])
  expect(r.edits.at(-1)).toContain('按了，畫面已經往下走')
  expect(r.edits.join('\n')).not.toContain('畫面沒變')
})

test('Joey\'s tap on a screen that never moves: twice, then the sentence says so', async () => {
  const r = rig({ changeAfter: null, model: () => ({ decision: decision({ action: 'ask_joey', to_joey: 'x' }), meta: {}, fail: null }) })
  await r.advance(0); await r.advance(9000)
  const res = await r.off.onTap(r.sent[0]!.buttons[0][0].callback_data, 'Advac777')
  expect(r.keys).toEqual(['Enter', 'Enter'])
  expect(res).toMatch(/^按了兩次，前後等了 \d+ 秒畫面都沒變$/)
})
