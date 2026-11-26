// Universe 002k (G16): a main parked on Claude Code's limit menu reads nothing. (a) WO-168 (Chiron 05:24:56Z): the wall-down step asks the menu on the main's
// pane of server.ts (mainMenu: the status record names it, the duty officer puts it to Joey) BEFORE the probe offer; nothing in lanes chooses or presses an
// option any more (pickContinueOption and the pane reader are retired); (b) a delivery that stays queued with the main alive and silent gets one push and a
// lane.main_deaf record; (c) the picker log carries the option labels. mainMenu and Logos are stand-ins; the "model" is a shell script. No network, no model.
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
// WO-168: what server.ts's mainMenu answers (null: no menu on the pane), and the calls it got (drive: the probe's)
const state = { menu: null as null | { text: string; asks: boolean }, calls: [] as boolean[], throws: false }
const deps: any = { role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async () => { order.push('offer'); return true }, streamOpen: () => true,                       // the main's MCP stream (PL4: the probe is an offer)
  sweepNow: () => { sweeps++; order.push('sweep') }, sendBot: async (_c: string, text: string) => { sent.push(text); return 7000 + sent.length }, joeyChatId: () => '1',
  mainMenu: async (drive: boolean) => { state.calls.push(drive); order.push('menu'); if (state.throws) throw new Error('no record'); return state.menu } }
L.lanesInit(deps)
L.__setMainConnected('mcp-main')
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
/** PL4: the main's turn ends in StopFailure rate_limit (ITS wall: the lanes' wall is another record); at its retry time the probe offer comes, and a menu
 *  on its pane is dealt with BEFORE that offer; the main takes the offer and its Stop ends the episode. Returns what Joey was told meanwhile. */
let cyc = 0
async function wallCycle(): Promise<string> {
  const k = sent.length
  const pid = L.__main().mainPid()!, p = `p-${Math.random().toString(36).slice(2)}`
  const meta = { chat_id: '1', message_id: String(5000 + ++cyc), user: 'joey_lab' }
  await L.routeEvent({ id: `tg-1-${meta.message_id}`, source: 'telegram', from: 'joey', text: '在嗎', meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: '在嗎', meta } } } as any)
  const item = L.__main().items(r => r.event === `tg-1-${meta.message_id}`)[0]
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: p, dids: [item.id] })
  await L.__mainEvent({ event: 'StopFailure', pid, prompt_id: p, error: 'rate_limit', reason: LIMIT })
  expect(L.__main().mainPhase()).toBe('walled'); expect(L.wallActive()).toBe(false)                // its own wall, not the lanes'
  state.calls = []; order.length = 0
  expect(await until(() => { void L.__main().tick(); return L.__main().items(r => r.id === item.id)[0].state === 'offered' })).toBe(true)   // the probe offer
  const p2 = `p-${Math.random().toString(36).slice(2)}`
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: p2, dids: [item.id] }); await L.__mainEvent({ event: 'Stop', pid, prompt_id: p2, phase: 'final' })
  expect(L.__main().mainPhase()).toBe('idle')
  expect(await until(() => sent.some((s, i) => i >= k && s.includes('主線恢復了')))).toBe(true)
  return sent.slice(k).join('\n')
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

test('WO-168: nothing in lanes chooses or presses a menu option: the limit menu reader is retired (its owner is the duty officer)', () => {
  for (const k of ['pickContinueOption', 'mainMenuOwned', 'menuOwnerOf', 'menuOwnerFile', 'MENU_OWNER_FRESH_S']) expect((L as any)[k]).toBeUndefined()
})

// ------------------------------------------------------------------ (b) the deaf main
const T0 = Date.now() - 600_000
function resetMain(body: string, pid = process.pid) {
  writeFileSync(T, body)
  ;(L as any).__setMainPid(pid)
  delete st.main_wall; delete (st as any).main_deaf
  state.menu = null; state.calls = []; state.throws = false
}
const quiet = async (deliveredAt: number, now = Date.now()) => L.noteMainDeaf(deliveredAt, now)

test('G16a, PL4 (WO-168): the walled main\'s probe with a menu on its pane: server.ts\'s mainMenu is asked BEFORE anything is offered (the duty officer puts it to Joey); its sentence rides the one wall-down notice', async () => {
  state.menu = { text: '主線停在一個選單：1. Stop and wait for limit to reset｜2. Wait here, then continue automatically at 5:48 PM；值班員已把選項傳給你，等你選。', asks: false }
  const notice = await wallCycle()
  expect(state.calls).toEqual([true])                                                              // the probe's call: drive
  expect(order[0]).toBe('menu')                                                                    // before the offer
  expect(notice).toContain('值班員已把選項傳給你'); expect(notice).toContain('1. Stop and wait for limit to reset')
  expect(notice.split('〔adam·分流器〕').length - 1).toBe(2)                                   // 002q (T7-R 1016): up and down; the menu rides the down notice
  expect(notice.indexOf('主線停在一個選單')).toBeGreaterThan(notice.indexOf('主線恢復了'))
})

test('G16a (WO-168): a menu nobody put to Joey (the duty officer off): he is told at the probe', async () => {
  state.menu = { text: '它停在一個選單：1. Upgrade your plan｜2. Request more usage；值班員沒有在看這個畫面，選項沒有傳給你。', asks: true }
  const notice = await wallCycle()
  expect(state.calls).toEqual([true])
  expect(notice).toContain('值班員沒有在看這個畫面')
  expect(notice.indexOf('值班員沒有在看這個畫面')).toBeLessThan(notice.indexOf('主線恢復了'))     // told at the probe, not with the down notice
})

test('G16a: no menu on the pane (or no record, or no mainMenu): the main\'s wall notices are as before', async () => {
  state.menu = null
  let notice = await wallCycle()
  expect(state.calls).toEqual([true]); expect(notice).not.toContain('選單')
  const was = deps.mainMenu; deps.mainMenu = undefined
  notice = await wallCycle(); expect(notice).not.toContain('選單')
  deps.mainMenu = was; state.throws = true
  notice = await wallCycle(); expect(notice).not.toContain('選單')
  state.throws = false
})
