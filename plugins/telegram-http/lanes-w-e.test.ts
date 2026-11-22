// 002w (E): delivery to the main. M1 offers the oldest owed item whose own stream can take it (an item whose stream is down no longer holds the others);
// the stuck rule also counts owed items nobody could take, with no live gen ("主線不在") or a gen that cannot be offered them ("主線收不到訊息"): one alarm
// per episode with the queued count, cleared by the next delivery; and the main's wall is an episode of the agent: a gen that ended walled hands it to the
// next gen, whose first final Stop tells Joey it is over. Stand-in main processes; each test names the path and the gap of DUTY-INVENTORY.md.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { __setMainStuckMs, MAIN_STUCK_MS } from './lanes-main.ts'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?w-e-test') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-w-e-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const open = new Set<string>(), sent: string[] = [], offers: any[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async (sid: string, n: any) => { if (!open.has(sid)) return false; offers.push(n); return true }, streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async (_c: string, text: string) => { sent.push(text); return 5000 + sent.length }, joeyChatId: () => '1' } as any)
L.__setWallProbe(3_600_000)
const was = MAIN_STUCK_MS
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } __setMainStuckMs(was); L.__setWallProbe(300_000); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const M = () => L.__main()
type Gen = { pid: number; sid: string; proc: any; mcp: string }
async function startMain(stream = true): Promise<Gen> {
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  const sid = randomUUID(), g = { pid: proc.pid, sid, proc, mcp: `mcp-${proc.pid}` }
  writeFileSync(join(dir, 'main-expected'), sid)
  if (stream) open.add(g.mcp)
  L.__noteMcpPid(g.mcp, g.pid)
  await L.__mainEvent({ event: 'SessionStart', pid: g.pid, session_id: sid, source: 'startup' })
  await M().pump()
  return g
}
const hook = (g: Gen, event: string, o: object = {}) => L.__mainEvent({ event, pid: g.pid, session_id: g.sid, ...o } as any)
async function gone(g: Gen) { g.proc.kill('SIGKILL'); await g.proc.exited; open.delete(g.mcp); await M().tick() }
let nj = 0
async function joey(text: string): Promise<string> {
  const id = String(9600 + ++nj), meta = { chat_id: '1', message_id: id, user: 'joey_lab' }
  await L.routeEvent({ id: `tg-1-${id}`, source: 'telegram', from: 'joey', text, meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)
  await sleep(20)
  return `tg-1-${id}`
}
const state = (ev: string) => M().items(r => r.event === ev && r.kind !== 'digest')[0]?.state
let np = 0
async function turn(g: Gen, ev: string) {
  const p = `pe-${++np}`
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: M().items(r => r.event === ev).map(r => r.id) })
  L.mainReplied(L.mainReplyTier({}), 5900 + np)
  let s = await hook(g, 'Stop', { prompt_id: p }); if (s.block) s = await hook(g, 'Stop', { prompt_id: p })
  await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
}

test('002w E, gap 4, path offer: a mesh item whose stream (the inbox daemon\'s) is down does not hold Joey\'s Telegram message behind it (2a936a7 offered only the oldest, and stopped)', async () => {
  const g = await startMain()
  await L.lanesCommand('/lanes off', 'joey')
  await L.routeEvent({ id: 'mesh-9501', source: 'mesh', from: 'eve', verified: true, text: '週三可以嗎？', btcc_msg_id: '9501', meta: {}, notif: { method: 'notifications/claude/channel', params: { content: '週三可以嗎？', meta: {} } } } as any)
  await L.lanesCommand('/lanes on', 'joey')
  await M().pump()
  expect(state('mesh-9501')).toBe('queued')                                                             // no inbox daemon here: its stream cannot take it
  const ev = await joey('現在怎樣？')
  await M().pump()
  expect(state(ev)).toBe('offered')
  await turn(g, ev)                                                                                     // the turn pulls the mesh item at its Stop
  expect(state('mesh-9501')).toBe('done')
  await gone(g)
})

test('002w E, gap 4, path stuck rule: owed items queued past MAIN_STUCK_MS that the live gen could not be offered (its stream is down) are one alarm with the count, cleared by the next delivery (2a936a7: no alarm)', async () => {
  __setMainStuckMs(150)
  const g = await startMain(false)                                                                       // registered, its MCP stream not open
  const ev = await joey('發票 4471 付了嗎？')
  expect(state(ev)).toBe('queued')
  await sleep(200); const k = sent.length
  await M().tick(); await M().tick()
  expect(sent.slice(k).filter(t => t.includes('主線收不到訊息')).length).toBe(1)
  expect(sent.slice(k).find(t => t.includes('主線收不到訊息'))).toContain('1 則')
  open.add(g.mcp); L.__noteMcpPid(g.mcp, g.pid)                                                        // the stream opens: delivered
  for (let i = 0; i < 50 && state(ev) !== 'offered'; i++) { await sleep(10); await M().pump() }
  expect(state(ev)).toBe('offered')
  expect(sent.slice(k).filter(t => t.includes('主線接到訊息了')).length).toBe(1)
  await turn(g, ev)
  __setMainStuckMs(was)
  await gone(g)
})

test('002w E, gap 11, path no live gen: Joey\'s messages waiting with nobody registered are one alarm 主線不在 with the count; the next gen\'s delivery clears it (2a936a7: told nothing)', async () => {
  __setMainStuckMs(150)
  const a = await joey('還在嗎？'), b = await joey('回一下')
  expect(M().currentGen()).toBeNull()
  await sleep(200); const k = sent.length
  await M().tick(); await M().tick()
  expect(sent.slice(k).filter(t => t.includes('主線不在')).length).toBe(1)
  expect(sent.slice(k).find(t => t.includes('主線不在'))).toContain('2 則')
  const g = await startMain()
  for (let i = 0; i < 50 && state(a) !== 'offered'; i++) { await sleep(10); await M().pump() }
  expect(state(a)).toBe('offered')
  expect(sent.slice(k).filter(t => t.includes('主線接到訊息了')).length).toBe(1)
  await turn(g, a); await M().pump()
  __setMainStuckMs(was)
  await turn(g, b)
  await gone(g)
})

test('002w E, gap 13, path a walled gen replaced: the main\'s wall is an episode of the agent: the next gen\'s first final Stop tells Joey once that it is over (2a936a7: the notice was lost with the gen)', async () => {
  const g1 = await startMain()
  const ev = await joey('查一下 mock-api')
  await hook(g1, 'UserPromptSubmit', { prompt_id: 'pe-w1', dids: M().items(r => r.event === ev).map(r => r.id) })
  const k = sent.length
  await hook(g1, 'StopFailure', { prompt_id: 'pe-w1', error: 'rate_limit', reason: "You've hit your limit" })
  expect(sent.slice(k).filter(t => t.includes('主線模型額度用完了')).length).toBe(1)
  await gone(g1)                                                                                        // killed while walled
  const g2 = await startMain()
  expect(M().currentGen()!.wall_since).toBeTruthy()                                                     // the episode goes on in the new gen
  await turn(g2, ev)
  expect(sent.slice(k).filter(t => t.includes('主線恢復了')).length).toBe(1)
  expect(M().currentGen()!.wall_since ?? null).toBeNull()
  const g3 = await startMain(); await gone(g2)
  await turn(g3, await joey('再一則'))
  expect(sent.slice(k).filter(t => t.includes('主線恢復了')).length).toBe(1)                           // once: the episode is over
  await gone(g3)
})
