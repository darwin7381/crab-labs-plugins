// M2, the main record (lanes-main.ts): one gen per main process, starting | idle | in_turn | walled | gone(end_reason), moved only by the main's hook
// events (/lanes/main-event) and one kill -0. The failures of class D (and the main half of L) of 002f–002n are played through those signals, with real
// processes standing in for the main. The registration context (the main-only rules) is checked here too. No transcript, no model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { __setMainStuckMs, MAIN_STUCK_MS, mainContext, notMainContext } from './lanes-main.ts'
const L = await import('./lanes.ts?m2-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-m2-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const offers: Array<{ sid: string; notif: any }> = [], open = new Set<string>(), sent: string[] = [], toolsChanged: string[] = []
const pane = { text: '', drives: 0 }
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async (sid: string, notif: any) => { if (!open.has(sid)) return false; offers.push({ sid, notif }); return true },
  streamOpen: (sid: string) => open.has(sid), toolsChanged: (sid: string) => { toolsChanged.push(sid) },
  sendBot: async (_c: string, text: string) => { sent.push(text); return 300 + sent.length }, joeyChatId: () => '1',
  mainPicker: { capture: async () => pane.text, detect: (p: string) => /limit/.test(p) ? { key: 'generic-1', title: 'limit', options: ['Wait here, then continue automatically', 'Upgrade your plan'] } : null,
    drive: async () => { pane.drives++; return 'ok' as const }, rearm: () => {} } } as any)
L.__setWallProbe(3_600_000)
const procs: any[] = []
const stuck0 = MAIN_STUCK_MS
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } __setMainStuckMs(stuck0); L.__setWallProbe(300_000) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const journal = (): any[] => readFileSync(join(dir, 'lanes', 'state.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
const mainLines = (pid: number) => journal().filter(l => l.rec === 'main' && l.id === String(pid))
const M = () => L.__main()
type Gen = { pid: number; sid: string; proc: any; mcp: string }
function proc(): { proc: any; pid: number } { const p = Bun.spawn(['sleep', '600']); procs.push(p); return { proc: p, pid: p.pid } }
async function startMain(sid = randomUUID(), expected = true): Promise<Gen & { r: any }> {
  const { proc: p, pid } = proc()
  if (expected) writeFileSync(join(dir, 'main-expected'), sid)
  const g = { pid, sid, proc: p, mcp: `mcp-${pid}` }
  open.add(g.mcp); L.__noteMcpPid(g.mcp, pid)
  const r = await L.__mainEvent({ event: 'SessionStart', pid, session_id: sid, source: 'startup' })
  await M().pump()
  return { ...g, r }
}
const hook = (g: Gen, event: string, o: object = {}) => L.__mainEvent({ event, pid: g.pid, session_id: g.sid, ...o })
async function killed(g: Gen): Promise<void> { g.proc.kill('SIGKILL'); await g.proc.exited; open.delete(g.mcp); await M().tick() }
let nj = 0
async function joey(text: string): Promise<string> {
  const id = ++nj + 500, meta = { chat_id: '1', message_id: String(id), user: 'joey_lab' }
  await L.routeEvent({ id: `tg-1-${id}`, source: 'telegram', from: 'joey', text, meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)
  await M().pump()
  return M().items(r => r.event === `tg-1-${id}`)[0].id
}
const state = (id: string) => M().items(r => r.id === id)[0]?.state
let np = 0
const P = () => `p2-${++np}`
/** what earlier tests left queued is taken by a gen of its own and finished, so that a test starts with an empty ledger (M1 is FIFO) */
async function drained(): Promise<void> {
  if (!M().items(r => r.state !== 'done' && r.kind !== 'digest').length) return
  const g = await startMain()
  for (let i = 0; i < 20; i++) {
    const offered = M().items(r => r.state === 'offered' && r.gen === String(g.pid))
    if (!offered.length) break
    const p = P()
    await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: offered.map(r => r.id) })
    await hook(g, 'Stop', { prompt_id: p })                                                  // pulls the rest
    await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
    await M().pump()
  }
  await killed(g)
}

test('registration: the keeper\'s session is the main (starting until its stream opens, then idle); the main-only rules come back as the SessionStart context', async () => {
  const sid = randomUUID(), { proc: p, pid } = proc()
  writeFileSync(join(dir, 'main-expected'), sid)
  const r = await L.__mainEvent({ event: 'SessionStart', pid, session_id: sid, source: 'startup' })
  expect(r.accepted).toBe(true); expect(r.additionalContext).toContain('你是 adam 的主線')
  expect(M().mainPhase()).toBe('starting')                                                  // no MCP stream of it yet: nothing can be offered
  open.add(`mcp-${pid}`); L.__noteMcpPid(`mcp-${pid}`, pid)
  expect(M().mainPhase()).toBe('idle')
  expect(mainLines(pid).map(l => l.state)).toEqual(['starting', 'idle'])
  expect(L.isMainMcpSession(`mcp-${pid}`)).toBe(true)
  await killed({ pid, sid, proc: p, mcp: `mcp-${pid}` })
})

test('002m LG1 / LG2: a second claude in the folder is refused: told it is not the main, its sessions get no Telegram tools, Joey is told once', async () => {
  const g = await startMain()
  const k = sent.length
  const { proc: p2, pid: pid2 } = proc()
  L.__noteMcpPid('mcp-second', pid2)
  const r = await L.__mainEvent({ event: 'SessionStart', pid: pid2, session_id: randomUUID(), source: 'startup' })
  expect(r.accepted).toBe(false); expect(r.additionalContext).toContain('你不是 adam 的主線')
  expect(L.sessionNotMain('mcp-second')).toBe(true); expect(L.sessionNotMain(g.mcp)).toBe(false)
  expect(toolsChanged).toContain('mcp-second')
  await sleep(10)
  expect(sent.slice(k).filter(s => s.includes('想登記成 adam 的主線')).length).toBe(1)
  await L.__mainEvent({ event: 'SessionStart', pid: pid2, session_id: (r as any).sid ?? randomUUID(), source: 'resume' })
  expect(M().mainPid()).toBe(g.pid)                                                          // the main is unchanged
  expect(L.notMainRefusal('reply')).toContain('not the main')
  p2.kill('SIGKILL'); await killed(g)
})

test('002f: a SIGKILLed main (no SessionEnd) is gone within one tick of kill -0; its MCP session says nothing about it', async () => {
  const g = await startMain()
  g.proc.kill('SIGKILL'); await g.proc.exited                                                // the stream stays "open" in the daemon's view
  expect(M().mainPhase()).toBe('idle')
  await M().tick()
  expect(M().mainPhase()).toBe('gone'); expect(mainLines(g.pid).at(-1)).toMatchObject({ state: 'gone', end_reason: 'killed' })
  expect(M().currentGen()).toBeNull()                                                        // PL3: nothing else follows from it (no away grace rewrites a due time)
  open.delete(g.mcp)
})

test('SessionEnd: gone, exited; the items of its open turn are queued again at once (no grace)', async () => {
  const g = await startMain()
  const id = await joey('第一個問題')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  await hook(g, 'SessionEnd', { reason: 'other' })
  expect(mainLines(g.pid).at(-1)).toMatchObject({ state: 'gone', end_reason: 'exited' })
  expect(state(id)).toBe('queued')
  await killed(g)
})

test('002g/002h: back in 3.5 s on the same session: the new process is a new gen; what the old one had is offered to it at once, with no carry-on notice', async () => {
  await drained()
  const sid = randomUUID()
  const g = await startMain(sid)
  const id = await joey('那份報告呢？')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  const g2 = await startMain(sid)                                                            // the keeper brought it back on the same session id
  expect(mainLines(g.pid).at(-1)).toMatchObject({ state: 'gone', end_reason: 'replaced' })
  expect(M().mainPid()).toBe(g2.pid)
  expect(state(id)).toBe('offered'); expect(M().items(r => r.id === id)[0].gen).toBe(String(g2.pid))
  expect(offers.at(-1)!.notif.params.content).toBe('那份報告呢？')                              // the message itself: no 〔系統通知｜主線重新啟動〕
  expect(M().items(r => r.kind === 'carry').length).toBe(0)
  await killed(g); await killed(g2)
})

test('002j 5018d39 (kept as data): /restart mid-turn ends the gen `asked`; the cut turn\'s items are not given again, Joey gets one line', async () => {
  const g = await startMain()
  const id = await joey('重跑一次部署')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  const k = sent.length
  L.markDeliberateRestart()
  await hook(g, 'SessionEnd', { reason: 'other' })
  expect(mainLines(g.pid).at(-1)).toMatchObject({ state: 'gone', end_reason: 'asked' })
  expect(M().items(r => r.id === id)[0]).toMatchObject({ state: 'done', reason: 'asked_restart' })
  await sleep(10)
  expect(sent.slice(k).filter(s => s.includes('主線被指令重啟')).length).toBe(1)
  // 002q (T8-R): that line is about the cut message: it is on its event and meets its Joey line, so the event does not close with the line owed
  const ev = M().items(r => r.id === id)[0].event
  const e = L.__events().get(ev)!
  expect(e.obligations.find((o: any) => o.kind === 'joey')).toMatchObject({ state: 'met', by: 'router (asked-restart)' })
  expect(e.router_sends).toEqual([expect.objectContaining({ to: 'joey', rule: 'asked-restart' })])
  expect(e.state).toBe('closed')
  await killed(g)
})

test('002l N7: a turn cut right after it took a channel message in (before any tool): bound with no Stop → queued; no regex decides it', async () => {
  const g = await startMain()
  const id = await joey('剛收到就被砍')
  await hook(g, 'UserPromptSubmit', { prompt_id: P(), dids: [id] })
  await killed(g)
  expect(state(id)).toBe('queued')
})

// PL4 (AUD P11/P13/P12, T7-R, T6-R, T8-R, G07): the main's wall and the lanes' wall are two records. M2's moves only on the main's own hook events.
const wallLines = (g: Gen) => mainLines(g.pid).filter(l => l.state === 'walled')
test('PL4 P11/P13 (T7-R 1247.3): the lanes\' wall going up or down never moves the main: a walled main stays walled, an idle main stays idle', async () => {
  await drained()
  const g = await startMain()
  const k = sent.length
  L.__wallUp('rate_limit', 'lane 429', 'adam.reflex.4.r1')                                   // P13: a lane's wall does not wall an idle main
  expect(M().mainPhase()).toBe('idle')
  const id = await joey('有空嗎')
  expect(state(id)).toBe('offered')                                                           // it is offered: the main has its own wall, and none
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  await hook(g, 'StopFailure', { prompt_id: p, error: 'rate_limit', reason: 'API Error: Request rejected (429)' })
  expect(M().mainPhase()).toBe('walled'); expect(mainLines(g.pid).at(-1)).toMatchObject({ state: 'walled', kind: 'rate_limit', probes: 0 })
  expect(mainLines(g.pid).at(-1).wall_since).toBeTruthy(); expect(state(id)).toBe('queued')
  await L.__wallDown('adam.reflex.4.r1'); await sleep(20)                                      // P11: a lane run gets through: the LANES' wall comes down ...
  expect(M().mainPhase()).toBe('walled'); expect(state(id)).toBe('queued')                    // ... and the main is not taken out of its own (no main signal)
  // 002q (G07): one limit, one notice up: the lanes' wall told Joey; the main hitting the same limit is recorded, not pushed again; the lanes'
  // recovery while the main is still walled is recorded too (the recovery is told when the last side is through)
  expect(sent.slice(k).filter(s => s.includes('車道模型額度用完了')).length).toBe(1)
  expect(sent.slice(k).filter(s => s.includes('主線模型額度') || s.includes('車道的模型恢復了') || s.includes('主線恢復')).length).toBe(0)
  const led = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => String(r.refs?.tier_rule ?? '').endsWith('+same-limit'))
  expect(led.map(r => r.refs.tier_rule)).toEqual(['main-wall-up+same-limit', 'wall-down+same-limit'])
  await killed(g)
})

test('002q G07: one subscription limit gives Joey one notice up and one down, for lanes and main together, whichever side hits it first and recovers last', async () => {
  await drained()
  const g = await startMain()
  const k = sent.length
  const id = await joey('週報好了嗎')
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  await hook(g, 'StopFailure', { prompt_id: p, error: 'rate_limit', reason: "You've hit your weekly limit" })   // the main first
  L.__wallUp('rate_limit', "You've hit your weekly limit", 'adam.reflex.3.r1')                          // then a lane on the same limit
  await sleep(20)
  expect(sent.slice(k).filter(s => s.includes('模型額度用完了')).length).toBe(1)
  expect(sent.slice(k).filter(s => s.includes('模型額度用完了'))[0]).toContain('主線')
  const p2 = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p2, dids: [id] }); await hook(g, 'Stop', { prompt_id: p2, phase: 'final' })   // the main through first
  await sleep(20)
  expect(sent.slice(k).filter(s => s.includes('恢復了')).length).toBe(0)                     // the lanes are still walled: recorded only
  await L.__wallDown('adam.reflex.3.r2'); await sleep(20)
  expect(sent.slice(k).filter(s => s.includes('恢復了')).length).toBe(1)                     // the last side through: one recovery notice
  expect(sent.slice(k).length).toBe(2)
  await killed(g)
})

test('PL4: the walled main is offered one item at its retry time (its probe); it leaves walled on its own hook event; a second StopFailure is the same episode (no notice, longer backoff); its Stop ends the episode with one notice', async () => {
  await drained()
  L.__setWallProbe(40)
  const g = await startMain()
  const k = sent.length
  const id = await joey('今天的報告呢？')
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  await hook(g, 'StopFailure', { prompt_id: p, error: 'rate_limit', reason: '429' })
  expect(state(id)).toBe('queued')
  await M().pump(); expect(state(id)).toBe('queued')                                           // not before its retry time
  await sleep(60); await M().tick()
  expect(state(id)).toBe('offered'); expect(M().mainPhase()).toBe('walled')                  // the probe offer: still walled until the main itself moves
  const p2 = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p2, dids: [id] })
  expect(M().mainPhase()).toBe('in_turn')                                                     // its own hook event
  await hook(g, 'StopFailure', { prompt_id: p2, error: 'rate_limit', reason: '429' })
  expect(mainLines(g.pid).at(-1)).toMatchObject({ state: 'walled', probes: 1 })
  expect(mainLines(g.pid).at(-1).retry_at - Date.now()).toBeGreaterThan(40)                  // backed off
  await sleep(120); await M().tick()
  expect(state(id)).toBe('offered')
  const p3 = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p3, dids: [id] }); await hook(g, 'Stop', { prompt_id: p3, phase: 'final' })
  expect(state(id)).toBe('done'); expect(M().mainPhase()).toBe('idle')
  expect(mainLines(g.pid).at(-1).wall_since).toBeNull()                                         // the episode is over (cleared)
  await sleep(20)
  expect(sent.slice(k).filter(s => s.startsWith('〔adam·分流器〕\n主線模型額度用完了')).length).toBe(1)   // one up ...
  expect(sent.slice(k).filter(s => s.includes('主線恢復了')).length).toBe(1)                  // ... one down, for one episode
  L.__setWallProbe(3_600_000)
  await killed(g)
})

test('PL4 P12: a StopFailure that is not an account kind (server_error, unknown) does not wall the main: the items queue again, the gen is idle, the next offer is the retry; no wall notice', async () => {
  await drained()
  const g = await startMain()
  const k = sent.length
  const id = await joey('幫我查一下')
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  await hook(g, 'StopFailure', { prompt_id: p, error: 'server_error', reason: '529 overloaded' })
  expect(M().mainPhase()).toBe('idle'); expect(mainLines(g.pid).at(-1)).toMatchObject({ state: 'idle', error: 'server_error' })
  expect(state(id)).toBe('queued')
  await M().tick(); expect(state(id)).toBe('offered')
  expect(L.wallActive()).toBe(false)                                                          // nor does it raise the lanes' wall
  expect(sent.slice(k).some(s => s.includes('額度') || s.includes('無法使用'))).toBe(false)
  const p2 = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p2, dids: [id] }); await hook(g, 'Stop', { prompt_id: p2, phase: 'final' })
  expect(state(id)).toBe('done')
  await killed(g)
})

test('002k G03 / SR3, P14: a turn with no hook event for MAIN_STUCK_MS is 疑似卡死: one alarm, cleared by the next event; an open tool call is work, not silence', async () => {
  __setMainStuckMs(40)
  const g = await startMain()
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p })
  await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Bash' })
  expect(mainLines(g.pid).at(-1)).toMatchObject({ state: 'in_turn', tool_open: 'Bash' })
  const k = sent.length
  await sleep(60); await M().tick(); await M().tick()
  expect(sent.slice(k).filter(s => s.includes('疑似卡死')).length).toBe(0)                   // P14 (G02 r1: a 2-minute Bash): no alarm while the tool runs
  await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'Bash' })
  await sleep(60); await M().tick(); await M().tick()
  await sleep(10)
  expect(sent.slice(k).filter(s => s.includes('疑似卡死') && !s.includes('解除')).length).toBe(1)
  await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Read' })
  await sleep(10)
  expect(sent.slice(k).filter(s => s.includes('疑似卡死解除')).length).toBe(1)
  __setMainStuckMs(stuck0)
  await killed(g)
})

test('fleet #13 / SIGSTOP wedge: a stopped main sends no hook event; the stuck rule fires from that silence; the item stays with it, SIGCONT clears the alarm', async () => {
  __setMainStuckMs(40)
  const g = await startMain()
  const id = await joey('在嗎')
  await hook(g, 'UserPromptSubmit', { prompt_id: P(), dids: [id] })
  g.proc.kill('SIGSTOP')
  const k = sent.length
  await sleep(60); await M().tick(); await sleep(10)
  expect(M().mainPhase()).toBe('in_turn')                                                   // kill -0 still answers: not gone
  expect(state(id)).toBe('bound')
  expect(sent.slice(k).filter(s => s.includes('疑似卡死')).length).toBe(1)
  g.proc.kill('SIGCONT')
  await hook(g, 'PostToolUse', { prompt_id: M().currentGen()!.prompt_id, tool_name: 'Read' })
  await sleep(10)
  expect(sent.slice(k).some(s => s.includes('疑似卡死解除'))).toBe(true)
  __setMainStuckMs(stuck0)
  await killed(g)
})

test('D3 (basics): the main frozen with SIGSTOP while items are offered: exactly one 疑似卡死, nothing offered twice, no clock reset; SIGCONT and its next hook event clear it', async () => {
  await drained()
  __setMainStuckMs(80)
  const g = await startMain()
  g.proc.kill('SIGSTOP')                                                                    // frozen first, then the offers are written into it
  const k = sent.length, o = offers.length
  const a = await joey('D3 第一則'), b = await joey('D3 第二則')
  expect(state(a)).toBe('offered'); expect(state(b)).toBe('queued')                         // one offer opens one turn
  for (let i = 0; i < 12; i++) { await sleep(25); await M().tick() }                        // ~3.5 × MAIN_STUCK_MS of silence, a tick every 25 ms
  await sleep(10)
  expect(M().mainPhase()).toBe('idle')                                                      // kill -0 answers a stopped process: the gen is not gone
  expect(sent.slice(k).filter(s => s.includes('疑似卡死')).length).toBe(1)
  expect(sent.slice(k).find(s => s.includes('疑似卡死'))).toContain('沒有被接手')
  expect(offers.length).toBe(o + 1)                                                         // the offer was written once; nothing rewrote it
  expect(journal().filter(l => l.rec === 'msg' && l.id === a).map(l => l.state)).toEqual(['queued', 'offered'])
  expect(journal().some(l => l.reason === 'offer_unanswered')).toBe(false)
  g.proc.kill('SIGCONT')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [a] })                            // the stopped client takes what was written into it
  await sleep(10)
  expect(sent.slice(k).filter(s => s.includes('疑似卡死解除')).length).toBe(1)
  expect(state(a)).toBe('bound')
  await hook(g, 'Stop', { prompt_id: p })                                                   // the second one is pulled at Stop
  expect(state(b)).toBe('bound')
  await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
  expect(state(a)).toBe('done'); expect(state(b)).toBe('done')
  for (let i = 0; i < 4; i++) { await sleep(25); await M().tick() }                         // idle with nothing offered owes nothing: no second alarm
  expect(sent.slice(k).filter(s => s.includes('疑似卡死') && !s.includes('解除')).length).toBe(1)
  __setMainStuckMs(stuck0)
  await killed(g)
})

test('D3, a second episode: after the alarm cleared, a new silence with an open turn is a new episode and alarms once more', async () => {
  __setMainStuckMs(40)
  const g = await startMain()
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p })
  const k = sent.length
  g.proc.kill('SIGSTOP'); await sleep(60); await M().tick(); await M().tick()
  g.proc.kill('SIGCONT'); await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Bash' }); await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'Bash' })
  g.proc.kill('SIGSTOP'); await sleep(60); await M().tick(); await M().tick()                // a new silence with no tool open (P14)
  g.proc.kill('SIGCONT'); await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Read' })
  await sleep(10)
  expect(sent.slice(k).filter(s => s.includes('疑似卡死') && !s.includes('解除')).length).toBe(2)
  expect(sent.slice(k).filter(s => s.includes('疑似卡死解除')).length).toBe(2)
  __setMainStuckMs(stuck0)
  await killed(g)
})

test('the stream the offer needs: the SDK transport keeps its GET stream where server.ts streamLive looks (an SDK upgrade that moves it fails here)', async () => {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js')
  const t: any = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'x' })
  expect(t._webStandardTransport?._streamMapping instanceof Map).toBe(true)
  expect(t._webStandardTransport._standaloneSseStreamId).toBe('_GET_stream')
  expect(readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')).toContain("_webStandardTransport?._streamMapping?.has?.('_GET_stream')")
})

test('002k G16b: an idle main that never takes its offer (a menu on its pane) is the same rule: one alarm, with the pane read', async () => {
  await drained()
  __setMainStuckMs(40)
  const g = await startMain()
  pane.text = "You've hit your weekly limit\n 1. Wait here, then continue automatically\n 2. Upgrade your plan"
  const id = await joey('哈囉')
  expect(state(id)).toBe('offered')
  const k = sent.length
  await sleep(60); await M().tick(); await sleep(10)
  const alarm = sent.slice(k).find(s => s.includes('疑似卡死'))!
  expect(alarm).toContain('沒有被接手'); expect(alarm).toContain('Upgrade your plan')
  expect(pane.drives).toBe(0)                                                               // read, never pressed here
  pane.text = ''
  __setMainStuckMs(stuck0)
  await hook(g, 'UserPromptSubmit', { prompt_id: P(), dids: [id] })
  await killed(g)
})

test('/main renew: the brief is a carry item for the NEW session only; the old gen ends `replaced`; the new one is offered the brief first', async () => {
  await drained()
  const g = await startMain()
  const out = await L.mainRenew('joey_lab')
  expect(out).toContain('主線換新中')
  const st = L.__lanesState()
  const newSid = st.renew!.new_sid
  const brief = M().items(r => r.kind === 'carry')[0]
  expect(brief.target).toBe(newSid); expect(brief.state).toBe('queued')                    // the old main (idle) is not offered it
  expect(String(brief.notif.params.content)).toContain('主線交接')
  await sleep(700)                                                                           // the daemon stops the old process
  const { proc: p2, pid: pid2 } = proc()
  open.add(`mcp-${pid2}`); L.__noteMcpPid(`mcp-${pid2}`, pid2)
  const r = await L.__mainEvent({ event: 'SessionStart', pid: pid2, session_id: newSid, source: 'startup' })
  expect(r.accepted).toBe(true)
  expect(mainLines(g.pid).at(-1)).toMatchObject({ state: 'gone', end_reason: 'replaced' })
  await M().pump()
  expect(M().items(r => r.id === brief.id)[0]).toMatchObject({ state: 'offered', gen: String(pid2) })
  expect(st.renew).toBeUndefined()
  await killed({ pid: pid2, sid: newSid, proc: p2, mcp: `mcp-${pid2}` })
  open.delete(g.mcp)
})

test('the main-only rules: ledger_query before answering what happened (one line), digest rides along and never wakes it, the lane tools by name; not in a lane card or the not-main context', () => {
  const ctx = mainContext('adam', 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed')
  expect(ctx).toContain('先呼叫一次 ledger_query()（不帶任何參數）'); expect(ctx).toContain('清單裡每一件都要交代到')
  expect(ctx.split('\n').filter(l => l.includes('ledger_query')).length).toBe(1)
  expect(ctx).toContain('不要重複通知他'); expect(ctx).toContain('車道摘要'); expect(ctx).toContain('不會為了它單獨叫醒你')
  expect(ctx).toContain('fan_out(tasks, conclusion)'); expect(ctx).toContain('commitment(who, what, by, due)'); expect(ctx).toContain('ToolSearch')
  const names = L.mainToolDefs().map((t: any) => t.name)
  for (const n of ['fan_out', 'commitment', 'commitment_done', 'curate_memory', 'curate_stop', 'memory_decide', 'open_worker', 'fork', 'peer_hold']) expect(names).toContain(n)
  const card = L.identityCard({ kind: 'reflex' } as any)
  expect(card).not.toContain('ledger_query'); expect(card).not.toContain('車道摘要')
  expect(notMainContext('adam', 'x')).not.toContain('ledger_query')
})

test('RBU2: a turn ends at its last Stop. After a Stop the gen is idle with stopped_prompt; a later event of that prompt (another Stop hook blocked it) puts it back in_turn; a new prompt is a new turn, nothing interrupted', async () => {
  await drained()
  const g = await startMain()
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p })
  await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
  expect(M().currentGen()).toMatchObject({ state: 'idle', stopped_prompt: p }); expect(M().currentGen()!.prompt_id).toBeUndefined()
  await hook(g, 'Stop', { prompt_id: p, stop_hook_active: true })                          // continued with text only: its next Stop re-opens it
  expect(M().currentGen()).toMatchObject({ state: 'in_turn', prompt_id: p }); expect(M().currentGen()!.stopped_prompt).toBeUndefined()
  await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
  expect(M().currentGen()).toMatchObject({ state: 'idle', stopped_prompt: p })
  const p2 = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p2 })
  expect(M().currentGen()).toMatchObject({ state: 'in_turn', prompt_id: p2 }); expect(M().currentGen()!.stopped_prompt).toBeUndefined()
  expect(M().items(r => r.reason === 'interrupted' && r.gen === String(g.pid)).length).toBe(0)
  expect(mainLines(g.pid).map(l => l.state)).toEqual(['idle', 'in_turn', 'idle', 'in_turn', 'idle', 'in_turn'])
  await killed(g)
})

test('main-hook.py: one script for every event; with no daemon it holds nothing and prints nothing (and never reads the transcript)', async () => {
  const HOOK = join(import.meta.dir, 'lanes-hooks', 'main-hook.py')
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd']) {
    const p = Bun.spawn(['python3', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', LANES_DIR: dir, TYPESAFE_KEY_FILE: '/nonexistent' } })
    p.stdin.write(JSON.stringify({ hook_event_name: ev, session_id: 's', prompt_id: 'p', transcript_path: '/nonexistent/t.jsonl', cwd: dir })); p.stdin.end()
    expect((await new Response(p.stdout).text()).trim()).toBe(''); expect(await p.exited).toBe(0)
  }
  expect(readFileSync(HOOK, 'utf8')).not.toContain("open(p.get('transcript_path')")
})

// PL5 (AUD P16): the main's aids get the turn from M1/M2 (main-hook.py hands it on); nothing reads the transcript
test('PL5 P16: PreToolUse of the reply tool answers the turn (prompt, starts, bound items with the digest, every tool call with its result); Stop check answers the memory facts', async () => {
  await drained()
  const g = await startMain()
  const p0 = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p0 }); await hook(g, 'Stop', { prompt_id: p0, phase: 'final' })
  await sleep(5)
  const id = await joey('今天發生了什麼？')
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'mcp__lane__ledger_query' })
  await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'mcp__plugin_telegram-http_telegram-http__ledger_query', tool_input: {}, tool_response: '活動清單：1 件事', tool_error: false })
  await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'Bash', tool_input: { command: 'false' }, tool_response: 'exit 1', tool_error: true })
  const r = await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'mcp__plugin_telegram-http_telegram-http__reply' })
  expect(r.turn).toMatchObject({ prompt_id: p, items: [expect.objectContaining({ id, kind: 'joey', content: '今天發生了什麼？' })],
    calls: [{ name: 'mcp__plugin_telegram-http_telegram-http__ledger_query', input: {}, result: '活動清單：1 件事', error: false }, { name: 'Bash', input: { command: 'false' }, result: 'exit 1', error: true }] })
  expect(Date.parse(r.turn.started_at)).toBeGreaterThan(Date.parse(r.turn.prev_started_at))   // the turn before it (p0) started earlier
  expect((await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Bash' })).turn).toBeUndefined()   // only the reply tool is judged
  const s = await hook(g, 'Stop', { prompt_id: p })
  expect(s.turn.prompt_id).toBe(p); expect(Array.isArray(s.proposals)).toBe(true); expect(s.curator).toBe(false)
  await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
  const p2 = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p2 })
  expect((await hook(g, 'PreToolUse', { prompt_id: p2, tool_name: 'mcp__x__reply' })).turn.calls).toEqual([])   // a new turn starts empty
  await hook(g, 'Stop', { prompt_id: p2, phase: 'final' })
  await killed(g)
})
