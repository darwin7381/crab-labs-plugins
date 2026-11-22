// Universe 002y (X-4; 002x T8-R a-r3, u002x-T8-a-r3-20261121-064317 events.jsonl 150-163): the asked-restart notice listed every message still `bound` to
// the cut turn, answered or not. Joey's 2013 was answered at t=1388.88 (msg 2014; its event's Joey line met, ref 2014), the /restart came at 1389.42,
// and the notice (msg 2017) still told him 「重啟時它正在處理的 1 則訊息不會自動交給新的主線：昨天（2026-11-12）新進了幾張工單？。還要處理的話請再說一次」.
// The notice lists only the cut messages whose Joey line is still owed; a cut message already answered is closed without that sentence. The rest of
// the asked-restart design stays: the cut turn's items are done (asked_restart), never handed to the new main. The main is a `sleep` process; no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { writeFileSync } from 'fs'
const L = await import('./lanes.ts?y-x4-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-y-x4-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const open = new Set<string>(), sent: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async (sid: string) => open.has(sid), streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async (_c: string, text: string) => { sent.push(text); return 2100 + sent.length }, joeyChatId: () => '1' } as any)
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const M = () => L.__main()
type Gen = { pid: number; sid: string; proc: any; mcp: string }
async function startMain(): Promise<Gen> {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const g = { pid: p.pid, sid: randomUUID(), proc: p, mcp: `mcp-${p.pid}` }
  writeFileSync(join(dir, 'main-expected'), g.sid)
  open.add(g.mcp); L.__noteMcpPid(g.mcp, g.pid)
  await L.__mainEvent({ event: 'SessionStart', pid: g.pid, session_id: g.sid, source: 'startup' })
  await M().pump()
  return g
}
const hook = (g: Gen, event: string, o: object = {}) => L.__mainEvent({ event, pid: g.pid, session_id: g.sid, ...o })
let nj = 0
async function joey(text: string): Promise<{ item: string; ev: string; mid: string }> {
  const mid = String(2000 + ++nj), meta = { chat_id: '1', message_id: mid, user: 'joey_lab' }
  await L.routeEvent({ id: `tg-1-${mid}`, source: 'telegram', from: 'joey', text, meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)
  await M().pump()
  return { item: M().items(r => r.event === `tg-1-${mid}`)[0].id, ev: `tg-1-${mid}`, mid }
}
const joeyLine = (ev: string) => (L.__events().get(ev)!.obligations as any[]).find(o => o.kind === 'joey')
const notices = (k: number) => sent.slice(k).filter(s => s.includes('主線被指令重啟'))
async function restart(g: Gen): Promise<void> { L.markDeliberateRestart(); await hook(g, 'SessionEnd', { reason: 'other' }); await sleep(20); g.proc.kill('SIGKILL'); open.delete(g.mcp) }

test('002y X-4 (T8-R a-r3): the cut turn\'s message was answered just before the /restart: no 「請再說一次」 for it; it is closed, never handed to the new main', async () => {
  const g = await startMain()
  const q = await joey('昨天（2026-11-12）新進了幾張工單？')
  const p = `p-x4-${nj}`
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [q.item] })
  L.mainReplied(null, 2014)                                                                    // the main's answer (msg 2014, no quote) meets the turn's Joey line
  expect(joeyLine(q.ev)).toMatchObject({ state: 'met', by: 'main', ref: '2014' })
  const k = sent.length
  await restart(g)                                                                             // /restart 0.54 s later, the turn still open
  expect(M().items(r => r.id === q.item)[0]).toMatchObject({ state: 'done', reason: 'asked_restart' })
  expect(notices(k)).toEqual([])                                                               // answered: nothing tells Joey to say it again
  expect(L.__events().get(q.ev)!.router_sends ?? []).toEqual([])
  expect(joeyLine(q.ev)).toMatchObject({ state: 'met', by: 'main', ref: '2014' })
  expect(L.__events().get(q.ev)!.state).toBe('closed')
  const g2 = await startMain()
  await sleep(20)
  expect(M().items(r => r.id === q.item)[0].state).toBe('done')                                // the new main does not get it (no hand-back)
  await restart(g2)
})

test('002y X-4: two messages cut, one answered: the notice names only the one still owed and meets its Joey line; the answered one is closed without it', async () => {
  const g = await startMain()
  const a = await joey('mock-api 現在 health 怎樣？'), b = await joey('上週的事故報告寄給平台組了嗎？')
  const p = `p-x4-${nj}`
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [a.item, b.item] })
  expect(M().items(r => r.prompt_id === p).map(r => r.id).sort()).toEqual([a.item, b.item].sort())
  L.mainReplied(null, 2031, a.mid)                                                             // the main answered a (quoting it); b is still owed
  expect(joeyLine(a.ev).state).toBe('met'); expect(joeyLine(b.ev).state).toBe('handed')
  const k = sent.length
  await restart(g)
  const n = notices(k)
  expect(n.length).toBe(1)
  expect(n[0]).toContain('重啟時它正在處理的 1 則訊息不會自動交給新的主線：上週的事故報告寄給平台組了嗎？')
  expect(n[0]).not.toContain('mock-api 現在 health')
  expect(joeyLine(b.ev)).toMatchObject({ state: 'met', by: 'router (asked-restart)' })         // the notice is b's Joey line
  expect(L.__events().get(b.ev)!.router_sends).toEqual([expect.objectContaining({ rule: 'asked-restart' })])
  expect(L.__events().get(a.ev)!.router_sends ?? []).toEqual([])
  expect(joeyLine(a.ev)).toMatchObject({ state: 'met', by: 'main', ref: '2031' })
  for (const x of [a, b]) expect(M().items(r => r.id === x.item)[0]).toMatchObject({ state: 'done', reason: 'asked_restart' })
})
