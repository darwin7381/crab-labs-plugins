// WO-168 stage two × WO-197: on the daemon's own pane the startup-picker surfaces nothing while the duty officer handles it (the officer takes its menus
// through the record), but WO-197's observer still has to see that pane (it closes the Onsen Actions and the channel's permission prompts that left the
// screen). A skipped pane is read for the observer through the capture the daemon hands in (pane-look's one capture); a roamer pane is as before.
// No tmux: capture is a stand-in.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startStartupPickerWatchdog, type DetectedPicker } from './startup-picker.ts'

const MENU = ['   What do you want to do?', '   ❯ 1. Stop and wait for limit to reset', '     2. Wait here, then continue automatically at Dec 1, 6am',
  '   Enter to confirm · Esc to cancel'].join('\n')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(10) } return f() }

test('the own pane: observed through the capture handed in, never surfaced; a roamer pane: surfaced as before', async () => {
  const OWN = 'wo168-own', ROAM = 'wo168-roamer'
  const read: string[] = [], seen: Array<[string, string | null]> = [], surfaced: string[] = []
  startStartupPickerWatchdog({
    listTargets: async () => [{ label: 'channel-bot', tmux: OWN }, { label: 'roamer', tmux: ROAM }],
    skip: t => t === OWN,
    capture: async t => { read.push(t); return MENU },
    observe: (t, pk: DetectedPicker | null) => { seen.push([t.tmux, pk?.key ?? null]) },
    surface: s => { surfaced.push(s.picker!.tmux) }, log: () => {}, pollMs: 20,
  })
  expect(await until(() => seen.some(([t]) => t === OWN) && surfaced.length > 0)).toBe(true)
  expect(read).toContain(OWN)                                                          // read for the observer, through the given capture
  expect(seen.find(([t]) => t === OWN)![1]).not.toBeNull()                            // the menu on it is seen
  expect(surfaced.every(t => t === ROAM)).toBe(true)                                   // only the roamer pane is put to anyone from here
})

test('server.ts: the own pane is skipped while the duty officer handles it, and read through the one capture (the observer, the permission recheck)', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain('skip: tmux => dutyOfficer?.handles(tmux) ?? false,')
  expect(src).toContain('capture: tmux => ownPaneReader && tmux === ownPaneTmux ? ownPaneReader.fresh(PICKER_OWN_LOOK_MS).then(l => l?.visible ?? \'\') : capturePane(tmux),')
  expect(src).toContain("ownPaneReader && pk.tmux === ownPaneTmux ? ((await ownPaneReader.fresh(0))?.visible ?? '') : await capturePane(pk.tmux)")
})

// Codex stop review (11-27): a capture that fails is never a picker that went away. Before the keys: it throws, nothing is sent; after the keys: a failed
// look does not count, so with no readable look the result is 'stuck', never 'ok'. No tmux runs: the picker key never matches a real pane's.
import { driveStartupPicker, detectStartupPicker } from './startup-picker.ts'
test('driveStartupPicker: an unreadable pane before the keys throws (nothing sent); not 「gone」', async () => {
  let looks = 0
  await expect(driveStartupPicker('wo168-no-such-pane', 0, 'k', async () => { looks++; throw new Error('unreadable') })).rejects.toThrow('unreadable')
  expect(looks).toBe(1)
})
test('server.ts: the own pane\'s press and the lanes probe read through a look that throws when it failed, never an empty screen', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain("return () => ownPaneReader.fresh(0).then(l => { if (!l) throw new Error(`pane ${tmux} could not be read`); return l.visible })")
  expect(src).toContain("ownPaneReader.fresh(MAIN_PICKER_LOOK_MS).then(l => { if (!l) throw new Error('the main\\'s pane could not be read'); return l.visible })")
  expect(src).toContain("acts.cancel(h, '這一刻讀不到畫面，沒有按；選單還在的話會再問一次')")
  void detectStartupPicker
})
