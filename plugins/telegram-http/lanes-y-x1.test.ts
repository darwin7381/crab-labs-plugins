// Universe 002y (X-1; 002x T7-R, every play, e.g. u002x-T7-s6-r3-20261121-063651 events.jsonl 189-223): the main's limit menu had two owners. The
// main hit its limit (main-wall-up, msg 2013 @1231.98); the startup-picker watchdog (an 8 s pane poll) rang Joey with the menu's buttons 2.2 s later
// (msg 2015 「🔀 claude 停在一個選單，請選擇：What do you want to do?」), and at the probe 44 s after that the lanes main-wall mechanism chose
// 「Wait here, then continue automatically at Nov 21, 7:42am」 itself (lane.main_menu, ledger main-menu+handled): Joey was asked to pick what the router
// then picked for him. With lanes on, the menu on the main's pane in its wall episode (and a limit menu drawn before the main's StopFailure reaches the
// daemon) is the main-wall mechanism's: the watchdog sends it only when that mechanism puts it in front of Joey (rearmStartupPicker). An option that
// could spend money is never chosen; then Joey gets the menu. Lanes off (no owner): the watchdog as before.
// The pane, the key presses and the bot are stand-ins (as in lanes-g16); the watchdog, its debounce and rearm are the real ones. No model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { detectStartupPicker, startStartupPickerWatchdog, rearmStartupPicker } from './startup-picker.ts'

const L = await import('./lanes.ts?y-x1-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-y-x1-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const T = join(dir, 'main.jsonl')
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'b31fc8d0-a35a-4365-9a21-9e16e9f78fed', transcript_path: T, claude_pid: process.pid, registered_at: new Date().toISOString() }))
writeFileSync(T, '')
L.__setWallProbe(100)

// the limit menu as Claude Code draws it, with the options of the T7-R plays (u002x-T7-s6-r3 events.jsonl 222, lane.main_menu)
const LIMIT = "You've hit your weekly limit · resets Nov 21, 7:42am (Asia/Taipei)"
const LIMIT_PANE = (opts: string[]) => `\n ${LIMIT}\n\n What do you want to do?\n\n${opts.map((o, i) => ` ${i === 0 ? '❯' : ' '} ${i + 1}. ${o}`).join('\n')}\n\n Enter to confirm · Esc to cancel\n`
const T7 = ['Stop and wait for limit to reset', 'Wait here, then continue automatically at Nov 21, 7:42am', 'Upgrade your plan']
const MONEY = ['Switch to extra usage', 'Upgrade your plan']
const NORMAL = '\n ╭───────────────╮\n │ > \n ╰───────────────╯\n'
const MAIN = 'genesis-y-x1-main', OTHER = 'genesis-y-x1-roamer', OFF = 'genesis-y-x1-lanes-off'
const pane: Record<string, string> = { [MAIN]: NORMAL, [OTHER]: NORMAL, [OFF]: NORMAL }
const drives: Array<{ idx: number; key: string }> = []
const sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async () => true, streamOpen: () => true, sendBot: async (_c: string, text: string) => { sent.push(text); return 7300 + sent.length }, joeyChatId: () => '1',
  mainPicker: { capture: async () => pane[MAIN], detect: detectStartupPicker,
    drive: async (idx: number, key: string) => { drives.push({ idx, key }); pane[MAIN] = NORMAL; return 'ok' },
    rearm: () => rearmStartupPicker(MAIN) } } as any)
L.__setMainConnected('mcp-main')
afterAll(() => { for (const k of Object.keys(pane)) pane[k] = NORMAL; L.__setWallProbe(300_000) })

// the watchdog as server.ts starts it: with GENESIS_LANES=1 the owner of a menu on the main's pane is asked first; with lanes off there is no owner
const rung: Array<{ title: string; buttons: string[] }> = []
const wlog: string[] = []
const owner = (t: { tmux: string }, pk: { options: string[] }) => t.tmux === MAIN && (L as any).mainMenuOwned(pk.options) ? 'the lanes main-wall probe' : null
startStartupPickerWatchdog({ listTargets: async () => [{ label: 'channel-bot', tmux: MAIN }, { label: 'roamer', tmux: OTHER }], capture: async (t: string) => pane[t],
  surface: s => rung.push({ title: s.title, buttons: s.buttons.map(b => b.text) }), log: (_l, m) => wlog.push(m), pollMs: 20, owner } as any)
const offRung: string[][] = []
startStartupPickerWatchdog({ listTargets: async () => [{ label: 'channel-bot', tmux: OFF }], capture: async (t: string) => pane[t],
  surface: s => offRung.push(s.buttons.map(b => b.text)), log: () => {}, pollMs: 20 })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
let n = 0
/** Joey's message reaches the main and its turn opens (UserPromptSubmit binds the item) */
async function turn(text: string): Promise<{ pid: number; p: string; item: string }> {
  const pid = L.__main().mainPid()!, p = `p-x1-${++n}`, meta = { chat_id: '1', message_id: String(6100 + n), user: 'joey_lab' }
  await L.routeEvent({ id: `tg-1-${meta.message_id}`, source: 'telegram', from: 'joey', text, meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)
  const item = L.__main().items(r => r.event === `tg-1-${meta.message_id}`)[0]
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: p, dids: [item.id] })
  return { pid, p, item: item.id }
}
/** the probe offer at the walled main's retry time; the main takes it and its Stop ends the episode (the wall-down notice) */
async function probeAndRecover(pid: number, item: string, k: number): Promise<void> {
  expect(await until(() => { void L.__main().tick(); return L.__main().items(r => r.id === item)[0].state === 'offered' })).toBe(true)
  const p2 = `p-x1-${++n}`
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: p2, dids: [item] }); await L.__mainEvent({ event: 'Stop', pid, prompt_id: p2, phase: 'final' })
  expect(L.__main().mainPhase()).toBe('idle')
  expect(await until(() => sent.slice(k).some(s => s.includes('主線恢復了')))).toBe(true)
}
const wallUps = (k: number) => sent.slice(k).filter(s => s.includes('主線模型額度用完了')).length

test('002y X-1 (T7-R): the main walls on the limit menu: the main-wall probe chooses 「Wait here, then continue automatically」, the watchdog never rings Joey with the menu, and Joey hears the wall once', async () => {
  const k = sent.length, r0 = rung.length
  const { pid, p, item } = await turn('存取日誌 20 頁的 5xx 幫我數一下')
  pane[MAIN] = LIMIT_PANE(T7)                                                                 // the limit cuts the turn; the menu is drawn
  await sleep(120)                                                                            // the watchdog polls before the StopFailure arrives (in the plays the push came 0.6-2.2 s after main-wall-up)
  await L.__mainEvent({ event: 'StopFailure', pid, prompt_id: p, error: 'rate_limit', reason: LIMIT })
  expect(L.__main().mainPhase()).toBe('walled')
  await sleep(120)                                                                            // and in the wall episode
  expect(rung.length).toBe(r0)
  expect(wlog.some(m => m.includes('the lanes main-wall probe owns it'))).toBe(true)
  drives.length = 0
  await probeAndRecover(pid, item, k)
  expect(drives).toEqual([{ idx: 1, key: expect.stringMatching(/^generic-/) }])               // option 2, the T7-R choice; never 3 (Upgrade your plan)
  await sleep(80)
  expect(rung.length).toBe(r0)                                                                // no menu push in the whole episode
  expect(wallUps(k)).toBe(1)
  const told = sent.slice(k)
  expect(told.length).toBe(2)                                                                 // the wall, and its recovery with what was chosen
  expect(told[1]).toContain('已選「Wait here, then continue automatically at Nov 21, 7:42am」')
})

test('002y X-1: a limit menu whose only options could spend money: the probe chooses nothing and the menu goes to Joey once (he keeps that decision)', async () => {
  const k = sent.length, r0 = rung.length
  const { pid, p, item } = await turn('昨天新進幾張工單？')
  pane[MAIN] = LIMIT_PANE(MONEY)
  await L.__mainEvent({ event: 'StopFailure', pid, prompt_id: p, error: 'rate_limit', reason: LIMIT })
  await sleep(120)
  expect(rung.length).toBe(r0)                                                                // the main-wall mechanism's until its probe
  drives.length = 0
  expect(await until(() => { void L.__main().tick(); return rung.length > r0 })).toBe(true)  // the probe found no safe option: re-armed for Joey
  expect(drives).toEqual([])
  expect(rung.slice(r0).map(r => r.buttons)).toEqual([['1. Switch to extra usage', '2. Upgrade your plan']])
  expect(sent.slice(k).filter(s => s.includes('我挑不出一個安全的選項')).length).toBe(1)
  await sleep(120)
  expect(rung.length).toBe(r0 + 1)                                                            // once
  pane[MAIN] = NORMAL; await sleep(80)                                                        // Joey chose; the menu is gone (the watchdog sees it go)
  await probeAndRecover(pid, item, k)
  expect(wallUps(k)).toBe(1)
})

test('002y X-1: what the main-wall mechanism does not own is the watchdog\'s as before: a menu on the main\'s pane outside a wall, a menu on another pane during one, every menu with lanes off', async () => {
  const r0 = rung.length, o0 = offRung.length
  await sleep(80)
  pane[MAIN] = '\n Do you trust the files in this folder?\n\n ❯ 1. Yes, proceed\n   2. No, exit\n'
  expect(await until(() => rung.length === r0 + 1)).toBe(true)                                 // the main idle, no wall: rung at once
  pane[MAIN] = NORMAL; await sleep(80)
  pane[OFF] = LIMIT_PANE(T7)
  expect(await until(() => offRung.length === o0 + 1)).toBe(true)                              // lanes off: the limit menu is rung at once, as before
  expect(offRung.at(-1)).toEqual(T7.map((l, i) => `${i + 1}. ${l}`))
  pane[OFF] = NORMAL
  const k = sent.length
  const { pid, p, item } = await turn('mock-api 現在 health 怎樣？')
  pane[MAIN] = LIMIT_PANE(T7)
  await L.__mainEvent({ event: 'StopFailure', pid, prompt_id: p, error: 'rate_limit', reason: LIMIT })
  pane[OTHER] = '\n This session is 44d 6h old and 511.2k tokens.\n\n ❯ 1. Resume from summary (recommended)\n   2. Resume full session as-is\n   3. Don’t ask me again\n'
  expect(await until(() => rung.length === r0 + 2)).toBe(true)                                 // another pane in the main's wall: rung
  expect(rung.at(-1)!.title).toContain('session resume')
  pane[OTHER] = NORMAL; await sleep(80)
  await probeAndRecover(pid, item, k)
  expect(rung.length).toBe(r0 + 2)                                                            // and nothing for the main's own limit menu
})

test('002y X-1: a limit menu with no StopFailure (the turn stays open): the stuck alarm reads it and puts it in front of Joey', async () => {
  await sleep(80)
  const k = sent.length, r0 = rung.length
  drives.length = 0
  await turn('上週的事故報告整理一下')
  pane[MAIN] = LIMIT_PANE(T7)
  await sleep(120)
  expect(rung.length).toBe(r0)
  await L.__main().tick(Date.now() + 3_600_000)                                                // past the stuck bound, the turn still open
  const alarm = sent.slice(k).find(s => s.includes('主線疑似卡死'))!
  expect(alarm).toContain('它停在一個選單：1. Stop and wait for limit to reset｜2. Wait here, then continue automatically at Nov 21, 7:42am｜3. Upgrade your plan')
  expect(await until(() => rung.length === r0 + 1)).toBe(true)
  expect(drives.length).toBe(0)
})
