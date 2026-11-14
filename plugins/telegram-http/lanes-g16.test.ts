// Universe 002k (G16): a main parked on Claude Code's limit menu reads nothing. (a) the wall-down step looks at the pane and drives the option that continues or
// waits, never one that spends money; otherwise the menu goes to Joey again; (b) a delivery that stays queued with the main alive and silent gets one push and a
// lane.main_deaf record; (c) the picker log carries the option labels. Pane, drive and Logos are stand-ins; the "model" is a shell script. No network, no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, appendFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { detectStartupPicker, describePicker, startStartupPickerWatchdog, rearmStartupPicker } from './startup-picker.ts'

const logos: any[] = []
// the stand-in Logos must be up (and its URL in the environment) BEFORE lanes.ts is imported: the module reads GENESIS_LOGOS_URL once
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { try { logos.push(await req.json()) } catch {} ; return new Response('ok') } })
process.env.GENESIS_LOGOS_URL = `http://127.0.0.1:${server.port}`
afterAll(() => { server.stop(true); delete process.env.GENESIS_LOGOS_URL })
const L = await import('./lanes.ts?g16-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-g16-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const T = join(dir, 'main.jsonl')
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: T, claude_pid: process.pid, registered_at: new Date().toISOString() }))
writeFileSync(T, '')
const sent: string[] = []
let sweeps = 0
const order: string[] = []
const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p }
const WALLED = script('walled.sh', `echo '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You have hit your weekly limit · resets 5:48pm (Asia/Taipei)"}'\nexit 1`)
const OK = script('ok.sh', `echo '{"type":"result","subtype":"success","is_error":false,"result":"OK"}'\nexit 0`)
const restore = L.__setClaudeBin(WALLED)
L.__setWallProbe(100)
afterAll(() => { L.__setClaudeBin(restore); L.__setWallProbe(300_000) })

// the pane: the limit menu as claude 2.1.322 draws it (labels from its own menu code), then the normal prompt once a key has been sent
const LIMIT_PANE = (opts: string[]) => `\n You've hit your weekly limit · resets 5:48pm (Asia/Taipei)\n\n What do you want to do?\n\n${opts.map((o, i) => ` ${i === 0 ? '❯' : ' '} ${i + 1}. ${o}`).join('\n')}\n\n Enter to confirm · Esc to cancel\n`
const NORMAL = '\n ╭───────────────╮\n │ > \n ╰───────────────╯\n'
const SAFE = ['Wait here, then continue automatically at 5:48 PM', 'Upgrade your plan', 'Don’t continue automatically']
const state = { pane: NORMAL, drives: [] as Array<{ idx: number; key: string }>, rearms: 0, driveResult: 'ok' as 'ok' | 'gone' | 'stuck', clears: true }
const deps: any = { role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sweepNow: () => { sweeps++; order.push('sweep') }, sendBot: async (_c: string, text: string) => { sent.push(text); return 7000 + sent.length }, joeyChatId: () => '1',
  mainPicker: { capture: async () => state.pane, detect: detectStartupPicker,
    drive: async (idx: number, key: string) => { state.drives.push({ idx, key }); order.push('drive'); if (state.driveResult === 'ok' && state.clears) state.pane = NORMAL; return state.driveResult },
    rearm: () => { state.rearms++ } } }
L.lanesInit(deps)
L.__setMainConnected('mcp-main')
L.__setDigestIO({ mainConnected: async () => true, deliver: async () => true })
const st = L.__lanesState()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const rec = (o: object) => JSON.stringify(o) + '\n'
const iso = (ms: number) => new Date(ms).toISOString()
const LIMIT = "You've hit your weekly limit · resets 5:48pm (Asia/Taipei)"
const apiErr = (ms: number) => rec({ type: 'assistant', timestamp: iso(ms), isApiErrorMessage: true, message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: LIMIT }] } })
const turnEnd = (ms: number) => rec({ type: 'system', subtype: 'turn_duration', timestamp: iso(ms) })
const genuine = (ms: number) => rec({ type: 'assistant', timestamp: iso(ms), message: { model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '好' }] } })
const toolUse = (ms: number) => rec({ type: 'assistant', timestamp: iso(ms), message: { model: 'claude-haiku-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tuX', name: 'Bash', input: { command: 'make report' } }] } })
/** wall up (a newer error record in the main's transcript), then the probe gets through: returns the Joey notice that follows */
async function wallCycle(): Promise<string> {
  const k = sent.length
  L.__setClaudeBin(WALLED)
  const t = Date.now()
  appendFileSync(T, apiErr(t - 20) + turnEnd(t - 10))
  L.mainWallTick()
  expect(await until(() => L.wallHoldsMain())).toBe(true)
  await sleep(80)                                                                            // the wall going up has its own sweep (setTimeout 0): let it pass
  state.drives = []; state.rearms = 0; order.length = 0
  L.__setClaudeBin(OK)
  expect(await until(() => !L.wallHoldsMain())).toBe(true)
  expect(await until(() => sent.some((s, i) => i >= k && s.includes('主線的模型恢復了')))).toBe(true)
  return sent.slice(k).find(s => s.includes('主線的模型恢復了'))!
}

test('G16c: a picker is described with its real option labels, not only the count; the generic detector finds the limit menu', () => {
  const pk = detectStartupPicker(LIMIT_PANE(SAFE))!
  expect(pk.key).toStartWith('generic-'); expect(pk.options).toEqual(SAFE)
  const line = describePicker(pk, 'genesis-u002-adam')
  expect(line).toContain('3 options'); expect(line).toContain('1. Wait here, then continue automatically at 5:48 PM'); expect(line).toContain('2. Upgrade your plan'); expect(line).toContain('3. Don’t continue automatically')
})

test('G16c: the watchdog logs the labels when it surfaces a picker, and surfaces it again after rearmStartupPicker (a fresh debounce)', async () => {
  const logs: string[] = [], surfaced: any[] = []
  startStartupPickerWatchdog({ listTargets: async () => [{ label: 'main', tmux: 'g16-watch' }], surface: s => surfaced.push(s), log: (_l, m) => logs.push(m), pollMs: 30, capture: async () => LIMIT_PANE(SAFE) })
  expect(await until(() => surfaced.length === 1)).toBe(true)
  const l = logs.find(m => m.includes('surfacing to TG'))!
  expect(l).toContain('1. Wait here, then continue automatically'); expect(l).toContain('2. Upgrade your plan')
  expect(surfaced[0].buttons.length).toBe(3)
  await sleep(120); expect(surfaced.length).toBe(1)                                          // debounced: one episode, one surface
  rearmStartupPicker('g16-watch')
  expect(await until(() => surfaced.length === 2)).toBe(true)                                // re-armed: surfaced again
})

test('G16a: pickContinueOption picks the option that continues or waits, and never one that spends money, switches plan or model, or says do not continue', () => {
  expect(L.pickContinueOption(SAFE)).toBe(0)
  expect(L.pickContinueOption(['Stop and wait for limit to reset', 'Switch to extra usage', 'Upgrade your plan'])).toBe(0)
  expect(L.pickContinueOption(['Upgrade your plan', 'Wait here, then continue automatically when the limit resets', 'Stop'])).toBe(1)
  expect(L.pickContinueOption(['Wait here, then continue automatically shortly', 'Stop and wait for limit to reset'])).toBe(0)       // continue before wait
  expect(L.pickContinueOption(['Upgrade your plan', 'Request more usage', 'Add funds to continue'])).toBeNull()
  expect(L.pickContinueOption(['Don’t continue automatically', 'Upgrade your plan'])).toBeNull()
  expect(L.pickContinueOption(['Switch to Sonnet and continue', 'Buy extra usage ($20)'])).toBeNull()
  expect(L.pickContinueOption(['Resume from summary (recommended)', 'Resume full session as-is', 'Don’t ask me again'])).toBeNull()      // the resume menu: no
  expect(L.pickContinueOption(['Yes, I trust this folder', 'No, exit'])).toBeNull()
  expect(L.pickContinueOption([])).toBeNull()
})

test('G16a: wall down with the main on its limit menu: the continue option is driven BEFORE anything is handed to the main, and Joey is told what was chosen', async () => {
  state.pane = LIMIT_PANE(SAFE); state.driveResult = 'ok'
  const notice = await wallCycle()
  expect(state.drives.length).toBe(1); expect(state.drives[0].idx).toBe(0); expect(state.drives[0].key).toStartWith('generic-')
  expect(notice).toContain('主線停在一個選單'); expect(notice).toContain('2. Upgrade your plan'); expect(notice).toContain('已選「Wait here, then continue automatically at 5:48 PM」'); expect(notice).toContain('它繼續了')
  expect(state.rearms).toBe(0)
  expect(await until(() => order.includes('sweep'))).toBe(true)
  expect(order.indexOf('drive')).toBeLessThan(order.indexOf('sweep'))                        // the menu first, then what was kept is given
  const m = logos.filter(r => r.kind === 'lane.main_menu').at(-1)
  expect(m).toMatchObject({ why: 'wall-down', chose: { idx: 0 }, result: 'ok', resurfaced: false }); expect(m.options).toEqual(SAFE)   // the labels are in the daemon's record
  expect(logos.filter(r => r.kind === 'lane.main_wall_down').at(-1).menu).toMatchObject({ chose: 'Wait here, then continue automatically at 5:48 PM', result: 'ok' })
})

test('G16a: no safe option, a menu that is not about the limit, or a drive that did not take: nothing unsafe is pressed and the menu is put in front of Joey again', async () => {
  state.pane = LIMIT_PANE(['Upgrade your plan', 'Request more usage', 'Add funds']); state.driveResult = 'ok'
  let notice = await wallCycle()
  expect(state.drives.length).toBe(0); expect(state.rearms).toBe(1)
  expect(notice).toContain('我挑不出一個安全的選項'); expect(notice).toContain('選項已再傳給你')
  state.pane = '\n Do you want to continue with this setup?\n\n ❯ 1. Continue\n   2. Exit\n'                       // another menu that happens to say "continue": not the limit menu
  notice = await wallCycle()
  expect(state.drives.length).toBe(0); expect(state.rearms).toBe(1); expect(notice).toContain('我挑不出一個安全的選項')
  state.pane = LIMIT_PANE(SAFE); state.driveResult = 'stuck'
  notice = await wallCycle()
  expect(state.drives.length).toBe(1); expect(state.rearms).toBe(1); expect(notice).toContain('選了「Wait here'); expect(notice).toContain('選單還在')
  state.pane = LIMIT_PANE(SAFE); state.driveResult = 'gone'
  notice = await wallCycle()
  expect(state.drives.length).toBe(1); expect(state.rearms).toBe(0); expect(notice).toContain('選單已經不在了')    // answered somewhere else meanwhile: no action, nothing to re-arm
})

test('G16a: no menu on the pane (or no pane): the wall-down notice is as before', async () => {
  state.pane = NORMAL
  let notice = await wallCycle()
  expect(state.drives.length).toBe(0); expect(state.rearms).toBe(0); expect(notice).not.toContain('選單')
  const was = deps.mainPicker; deps.mainPicker = undefined
  notice = await wallCycle(); expect(notice).not.toContain('選單')
  deps.mainPicker = { ...was, capture: async () => { throw new Error('no tmux') } }
  notice = await wallCycle(); expect(notice).not.toContain('選單')
  deps.mainPicker = was
})

// ------------------------------------------------------------------ (b) the deaf main
const T0 = Date.now() - 600_000
function resetMain(body: string, pid = process.pid) {
  writeFileSync(T, body)
  deps.mainPicker = deps.mainPicker
  ;(L as any).__setMainPid(pid)
  delete st.main_wall; delete (st as any).main_deaf
  state.pane = NORMAL; state.drives = []; state.rearms = 0
}
const quiet = async (deliveredAt: number, now = Date.now()) => L.noteMainDeaf(deliveredAt, now)

test('G16b: a delivery queued for over a minute with the main alive, no open tool call and no new assistant record: one push, a ledger line, a lane.main_deaf record', async () => {
  const d0 = Date.now() - 90_000
  resetMain(genuine(T0) + turnEnd(T0 + 5))
  const k = sent.length
  expect(await quiet(d0)).toBe('noted')
  expect(sent.length).toBe(k + 1); expect(sent[k]).toContain('主線沒有在讀'); expect(sent[k]).toContain('已經 90 秒'); expect(sent[k]).toContain('停在選單，或沒有開新回合')
  expect(sent[k]).not.toContain('它停在一個選單')                                             // no menu on the pane: no menu sentence
  const led = await import('fs').then(f => f.readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.refs?.tier_rule === 'main-deaf'))
  expect(led.length).toBe(1); expect(led[0]).toMatchObject({ kind: 'notify', notify_main: true, refs: { tier: 'push', escalated: true } })
  await sleep(50)
  const r = logos.filter(x => x.kind === 'lane.main_deaf').at(-1)
  expect(r).toMatchObject({ queued_s: 90, pid: process.pid, menu: null }); expect(r.assistant_at).toBeGreaterThan(0)
  expect(await quiet(d0 + 1_000)).toBe('no'); expect(await quiet(d0 - 5_000)).toBe('no')   // other deliveries of the same silence: no second push
  expect(sent.length).toBe(k + 1)
})

test('G16b: a new stretch of silence (the main answered in between) is told again', async () => {
  const k = sent.length
  const answeredAt = Date.now() - 50_000
  appendFileSync(T, genuine(answeredAt) + turnEnd(answeredAt + 5))
  const d1 = answeredAt + 10_000                                                             // handed to the main after it answered, and nothing came of it
  expect(await quiet(d1, d1 + 75_000)).toBe('noted'); expect(sent.length).toBe(k + 1)
})

test('G16b: not deaf: under a minute, a tool call in progress, a process that is gone, a model wall, an assistant record after the delivery', async () => {
  const d = Date.now() - 90_000, base = genuine(T0) + turnEnd(T0 + 5), k = sent.length
  resetMain(base); expect(await quiet(Date.now() - 30_000)).toBe('no')                      // only 30 s
  resetMain(base + toolUse(Date.now() - 80_000)); expect(await quiet(d)).toBe('no')           // a tool call is open: the main is busy, mainStuckTick's business
  resetMain(base, 999_999); expect(await quiet(d)).toBe('no')                                // the process is gone: not "alive but not reading"
  resetMain(base); st.main_wall = { since: new Date().toISOString(), kind: 'usage', text: 'x', model: '', err_at: 0, mid_task: false, probes: 0 } as any
  expect(await quiet(d)).toBe('no'); delete st.main_wall                                     // behind the model wall: its own notice
  resetMain(base + genuine(d + 20_000)); expect(await quiet(d)).toBe('no')                   // it answered after the delivery
  expect(sent.length).toBe(k)
})

test('G16b: when the main sits on a menu, the push says which and the menu is put in front of Joey (no key is pressed)', async () => {
  resetMain(genuine(T0) + turnEnd(T0 + 5)); state.pane = LIMIT_PANE(SAFE)
  const k = sent.length
  expect(await quiet(Date.now() - 100_000)).toBe('noted')
  expect(sent[k]).toContain('主線沒有在讀'); expect(sent[k]).toContain('它停在一個選單'); expect(sent[k]).toContain('1. Wait here, then continue automatically at 5:48 PM'); expect(sent[k]).toContain('選項已再傳給你')
  expect(state.drives.length).toBe(0); expect(state.rearms).toBe(1)
  await sleep(50)
  expect(logos.filter(x => x.kind === 'lane.main_deaf').at(-1).menu).toEqual(SAFE)
})
