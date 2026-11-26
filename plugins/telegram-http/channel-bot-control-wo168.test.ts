// WO-168 stage two item 8 (Chiron 05:24:56Z): the checks before a Telegram command (/model, /effort, /codexgate, /resume) read the own pane's state from the
// status record of a look taken now (server.ts usePaneRecord: the one capture and screen-status.ts recordOf); the printed-output checks read that look's
// text; a roamer pane, or no record, reads its own capture as before. The records here are screen-status.ts's real composition of real screens.
import { afterAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeRecord, regionParts, screenFacts, screenHash } from './screen-status.ts'
import { stripAnsi } from './pane-look.ts'

const OWN = 'cbc-wo168-own'
process.env.CHANNEL_BOT_TMUX_SESSION = OWN
const C = await import('./channel-bot-control.ts?wo168') as typeof import('./channel-bot-control.ts')
afterAll(() => { C.usePaneRecord(null); delete process.env.CHANNEL_BOT_TMUX_SESSION })
const fx = (f: string) => readFileSync(join(import.meta.dir, 'test-fixtures', 'wo168', f), 'utf8')
const recordOf = (screen: string, prog = { state: 'idle', detail: {}, last_activity_at: null } as any) => {
  const v = stripAnsi(screen), p = regionParts(v)
  return composeRecord(null, p.st, prog, { alive: true }, { hash: screenHash(p), seen_at: Date.now(), facts: screenFacts(v, screen, p.st) }).view
}

test('recordIdle: idle, or walled with nothing open, is at its prompt; a menu, a turn, starting or offline is not', () => {
  expect(C.recordIdle(recordOf(fx('cc-02-idle.ansi')))).toBe(true)
  expect(C.recordIdle(recordOf(fx('cc-02-idle.ansi'), { state: 'idle', detail: { walled: { until: null } }, last_activity_at: null }))).toBe(true)   // /model during a wall still runs
  expect(C.recordIdle(recordOf(fx('cc-05-model.plain')))).toBe(false)
  expect(C.recordIdle(recordOf(fx('lab-limit-options-menu.txt'), { state: 'idle', detail: { walled: { until: null } }, last_activity_at: null }))).toBe(false)   // walled with its options open
  expect(C.recordIdle({ state: 'busy', detail: {} })).toBe(false); expect(C.recordIdle({ state: 'starting', detail: {} })).toBe(false)
})
test('recordYesNo: the Switch model? confirm with Yes under the cursor; the keyword in its question; not the resume list, not another menu', () => {
  for (const f of ['yes-no-confirm-1.txt', 'yes-no-confirm-2.txt', 'yes-no-confirm-3.txt']) {
    const r = recordOf(fx(f))
    expect(C.recordYesNo(r)).toBe(true)
    expect(C.recordYesNo(r, /Switch model\?/i)).toBe(true)
    expect(C.recordYesNo(r, /effort/i)).toBe(false)                                    // /effort never blind-confirms the /model dialog
  }
  expect(C.recordYesNo(recordOf(fx('cc-05-model.plain')))).toBe(false)
  expect(C.recordYesNo(recordOf(fx('lab-resume-picker.txt')))).toBe(false)
  const moved = fx('yes-no-confirm-2.txt').replace('❯ 1. Yes', '  1. Yes').replace('  2. No, go back', '❯ 2. No, go back')
  expect(C.recordYesNo(recordOf(moved))).toBe(false)                                  // the cursor is not on Yes: a bare Enter would not confirm
})
test('the own pane: the idle check reads the record (two looks); a roamer pane does not go to the record', async () => {
  const asked: string[] = []
  let screen = fx('cc-05-model.plain')
  C.usePaneRecord(async tmux => { asked.push(tmux); if (tmux !== OWN) return null; return { text: stripAnsi(screen), state: recordOf(screen).state, detail: recordOf(screen).detail as any } })
  expect(await C.isClaudeIdleStable(OWN)).toBe(false)                                 // a menu open: not idle
  screen = fx('cc-02-idle.ansi')
  expect(await C.isClaudeIdleStable(OWN)).toBe(true)
  expect(asked.filter(t => t === OWN).length).toBe(3)                                 // one look for the busy one, two for the stable idle
})
test('server.ts wires the record for the own pane only, from a look taken now', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain('usePaneRecord(async tmux => {')
  expect(src).toContain('if (!ownPaneReader || tmux !== ownPaneTmux || !ownRecordOf) return null')
  expect(src).toContain('const l = await ownPaneReader.fresh(250)')
})
