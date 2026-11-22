// Universe 002l (D11, RV3 G07 #6): the generic menu detector does not take numbered prose for a menu, and one menu is sent to Joey once.
// design/notify 「分流器同時管頻率上限與去重，同一件事不會連發」. Panes are strings; no tmux.
import { test, expect } from 'bun:test'
import { detectStartupPicker, startStartupPickerWatchdog, rearmStartupPicker } from './startup-picker.ts'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(15) } return f() }
const LIMIT = `\n You've hit your weekly limit · resets 5:48pm (Asia/Taipei)\n\n What do you want to do?\n\n ❯ 1. Wait here, then continue automatically at 5:48 PM\n   2. Upgrade your plan\n   3. Don’t continue automatically\n\n Enter to confirm · Esc to cancel\n`
// G07: the main's own numbered summary, drawn with the TUI's ● bullet, then the input box
const SUMMARY = `● 今天處理的事：\n\n● 1. mock-api p95 告警已恢復\n  2. Eve 的 WO-27 已回覆\n  3. 備份 403 已請 Joey 決定\n\n✻ Cooked for 12s\n\n╭────────────────────────────────────────────╮\n│ >                                          │\n╰────────────────────────────────────────────╯\n  ? for shortcuts\n`
const NEW_TUI = `● 下一步：\n❯ 1. 先查 mock-api\n  2. 再回 Eve\n────────────────────────────────────────────\n❯ \n────────────────────────────────────────────\n`
const FAR_UP = `❯ 1. old option\n  2. older option\n` + Array.from({ length: 20 }, (_, i) => `log line ${i}`).join('\n') + '\n'

test('D11: the limit menu is still found; numbered prose with the ● bullet, a cursor above the input box, or a cursor far up the pane is not a menu', () => {
  expect(detectStartupPicker(LIMIT)?.options.length).toBe(3)
  expect(detectStartupPicker(SUMMARY)).toBeNull()
  expect(detectStartupPicker(SUMMARY.replace('● 1.', '❯ 1.'))).toBeNull()                 // even with a real cursor glyph: the input box is below it
  expect(detectStartupPicker(NEW_TUI)).toBeNull()
  expect(detectStartupPicker(FAR_UP)).toBeNull()
  expect(detectStartupPicker('\n Pick one\n ● 1. Yes\n   2. No\n')).toBeNull()                 // ● is never a cursor
})

test('D11: a generic menu that comes and goes on the pane is sent once; rearmStartupPicker (a program that knows it is still up) sends it again', async () => {
  const surfaced: any[] = [], logs: string[] = []
  let pane = LIMIT
  startStartupPickerWatchdog({ listTargets: async () => [{ label: 'main', tmux: 'd11-watch' }], surface: s => surfaced.push(s), log: (_l, m) => logs.push(m), pollMs: 20, capture: async () => pane })
  expect(await until(() => surfaced.length === 1)).toBe(true)
  for (let i = 0; i < 3; i++) { pane = 'normal prompt\n'; await sleep(60); pane = LIMIT; await sleep(60) }   // three redraws of the same menu
  expect(surfaced.length).toBe(1)
  expect(logs.some(m => m.includes('not sent again'))).toBe(true)
  rearmStartupPicker('d11-watch')
  expect(await until(() => surfaced.length === 2)).toBe(true)
  pane = 'normal prompt\n'; await sleep(60); pane = LIMIT; await sleep(80)
  expect(surfaced.length).toBe(2)                                                          // the rearm was for once
  pane = 'normal prompt\n'
})
