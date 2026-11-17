// M1, the delivery ledger (lanes-main.ts): every item for the main is queued → offered(gen) → bound(gen, prompt) → done, and done ONLY when the turn it
// was bound to ends with Stop. The failures of class A (002j–002n) are played here through the main's own hook events (what main-hook.py posts to
// /lanes/main-event) against real processes that stand in for the main (`sleep`, killed with SIGKILL). No transcript, no model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
const L = await import('./lanes.ts?m1-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-m1-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const offers: Array<{ sid: string; notif: any }> = [], open = new Set<string>(), sent: string[] = []
const deps: any = { role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async (sid: string, notif: any) => { if (!open.has(sid)) return false; offers.push({ sid, notif }); return true },
  streamOpen: (sid: string) => open.has(sid), sendBot: async (_c: string, text: string) => { sent.push(text); return 100 + sent.length }, joeyChatId: () => '1' }
L.lanesInit(deps)
L.__setWallProbe(3_600_000)                                   // the probe never fires by itself here: tests take the wall down
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } L.__setWallProbe(300_000) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const journal = (): any[] => readFileSync(join(dir, 'lanes', 'state.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
const linesOf = (rec: string, id: string) => journal().filter(l => l.rec === rec && l.id === id)
const M = () => L.__main()
let np = 0
type Gen = { pid: number; sid: string; proc: any; mcp: string }
/** a process that stands in for the main: its SessionStart (accepted: the keeper's main-expected) and its open MCP stream */
async function startMain(sid = randomUUID()): Promise<Gen> {
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  writeFileSync(join(dir, 'main-expected'), sid)
  const g = { pid: proc.pid, sid, proc, mcp: `mcp-${proc.pid}` }
  open.add(g.mcp); L.__noteMcpPid(g.mcp, g.pid)
  const r = await L.__mainEvent({ event: 'SessionStart', pid: g.pid, session_id: sid, source: 'startup' })
  expect(r.accepted).toBe(true)
  await M().pump()
  return g
}
const hook = (g: Gen, event: string, o: object = {}) => L.__mainEvent({ event, pid: g.pid, session_id: g.sid, ...o })
async function kill(g: Gen): Promise<void> { g.proc.kill('SIGKILL'); await g.proc.exited; open.delete(g.mcp); await M().tick() }
let nj = 0
async function joey(text: string): Promise<string> {
  const id = ++nj + 200
  const meta = { chat_id: '1', message_id: String(id), user: 'joey_lab' }
  const d = await L.routeEvent({ id: `tg-1-${id}`, source: 'telegram', from: 'joey', text, meta, verified: true,
    notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)
  expect(d.target).toBe('main')
  await M().pump()
  return M().items(r => r.event === `tg-1-${id}`)[0].id
}
const state = (id: string) => M().items(r => r.id === id)[0]?.state
const P = () => `p-${++np}`

test('002n: a turn that ends in StopFailure never makes its item done: back to queued, the gen walled, nothing offered behind the wall; after the wall: offered once, done on Stop', async () => {
  const g = await startMain()
  const id = await joey('發票 4471 付了嗎？')
  expect(state(id)).toBe('offered'); expect(offers.at(-1)!.notif.params.meta.did).toContain(id)
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  expect(state(id)).toBe('bound')
  await hook(g, 'StopFailure', { prompt_id: p, error: 'rate_limit', reason: "API Error: Request rejected (429) · You've hit your weekly limit" })
  expect(state(id)).toBe('queued')
  expect(linesOf('msg', id).at(-1)).toMatchObject({ state: 'queued', reason: 'stop_failure:rate_limit' })
  expect(M().mainPhase()).toBe('walled'); expect(L.wallActive()).toBe(true)
  const k = offers.length
  await M().pump(); await M().tick()
  expect(offers.length).toBe(k)                                                          // a walled gen is offered nothing
  expect(sent.filter(s => s.includes('額度')).length).toBe(1)                            // Joey: one line for the wall
  await L.__wallDown()
  await sleep(20)
  expect(offers.length).toBe(k + 1); expect(offers.at(-1)!.notif.params.meta.did).toContain(id)    // offered again, once
  const p2 = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p2, dids: [id] })
  await hook(g, 'Stop', { prompt_id: p2, phase: 'final' })
  expect(state(id)).toBe('done')
  expect(linesOf('msg', id).filter(l => l.state === 'done').length).toBe(1)
  await kill(g)
})

test('002n T6/T8, 002m L6G1/L6T1, 002g: the main killed five times inside the turn that took the message: every new gen gets it again; done exactly once; no 疑似卡死, nothing quarantined', async () => {
  const id = await joey('幫我查 mock-api 的錯誤率')
  for (let i = 0; i < 5; i++) {
    const g = await startMain()
    expect(state(id)).toBe('offered')
    const p = P()
    await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
    await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Bash' })               // killed 0.46 s after a tool call (T8-R r3): bound, no Stop
    await kill(g)                                                                   // SIGKILL: no SessionEnd; kill -0 ends the gen
    expect(state(id)).toBe('queued')
    expect(linesOf('msg', id).at(-1)).toMatchObject({ reason: 'gen_end' })
    expect(linesOf('main', String(g.pid)).at(-1)).toMatchObject({ state: 'gone', end_reason: 'killed' })
  }
  const g = await startMain()
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
  expect(state(id)).toBe('done')
  expect(linesOf('msg', id).filter(l => l.state === 'done').length).toBe(1)
  expect(linesOf('msg', id).filter(l => l.state === 'offered').length).toBe(6)            // re-offer per gen IS the design; there is no cap
  expect(sent.some(s => s.includes('疑似卡死'))).toBe(false)
  expect(existsSync(join(dir, 'inbox', 'undeliverable'))).toBe(false)
  await kill(g)
})

test('002n (3 s skew), 002m G r2/r3: an item offered to a process that dies before it binds is queued again with the gen; no time is compared', async () => {
  const g = await startMain()
  const id = await joey('還在嗎？')
  expect(state(id)).toBe('offered')
  await kill(g)
  expect(state(id)).toBe('queued'); expect(linesOf('msg', id).at(-1)).toMatchObject({ reason: 'gen_end' })
  const g2 = await startMain()
  expect(state(id)).toBe('offered'); expect(linesOf('msg', id).at(-1).gen).toBe(String(g2.pid))
  const p = P(); await hook(g2, 'UserPromptSubmit', { prompt_id: p, dids: [id] }); await hook(g2, 'Stop', { prompt_id: p, phase: 'final' })
  expect(state(id)).toBe('done')
  await kill(g2)
})

test('002j: two offers at once (two replay paths in the old code) offer an item once: one writer, one transition', async () => {
  const g = await startMain()
  const k = offers.length
  const a = M().enqueue('joey', { method: 'notifications/claude/channel', params: { content: 'x', meta: {} } }, { via: 'tg' })
  await Promise.all([M().pump(), M().pump(), M().pump()])
  expect(offers.length).toBe(k + 1); expect(linesOf('msg', a).filter(l => l.state === 'offered').length).toBe(1)
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [a] }); await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
  await kill(g)
})

test('002h/002i: an offer is written only into a stream that can take it: no stream = still queued (no offer, no retry); the stream opening offers it once, done once', async () => {
  const g = await startMain()
  open.delete(g.mcp)                                                                   // the SDK has no GET stream of this process (yet, or any more)
  const id = await joey('剛開機就送的訊息')
  expect(state(id)).toBe('queued')
  expect(linesOf('msg', id).filter(l => l.state === 'offered').length).toBe(0)
  const k = offers.length
  await M().tick(); await M().tick()
  expect(offers.length).toBe(k); expect(state(id)).toBe('queued')
  open.add(g.mcp); L.__noteMcpPid(g.mcp, g.pid); await sleep(10)                       // the stream is there: the one offer
  expect(offers.length).toBe(k + 1); expect(state(id)).toBe('offered')
  await M().tick(); await M().tick()
  expect(offers.length).toBe(k + 1)                                                    // an offer is never written again to the same gen
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] }); await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
  expect(state(id)).toBe('done')
  expect(journal().some(l => l.reason === 'offer_unanswered')).toBe(false)
  await kill(g)
})

test('002l N6: behind the wall a new gen is walled from its SessionStart: the session-open replay of the old code has no counterpart; offered after the wall', async () => {
  L.__wallUp('rate_limit', 'weekly limit')
  const id = await joey('週報好了嗎')
  const g = await startMain()
  expect(M().mainPhase()).toBe('walled'); expect(state(id)).toBe('queued')
  await L.__wallDown(); await sleep(20)
  expect(state(id)).toBe('offered')
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] }); await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
  await kill(g)
})

test('a busy main is never pushed to: three messages are pulled at the next tool boundary and bound to the running prompt; a kill before Stop returns all three', async () => {
  const g = await startMain()
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p })                                  // a turn of its own (typed / scheduled)
  const k = offers.length
  const ids = [await joey('第一則'), await joey('第二則'), await joey('第三則')]
  expect(offers.length).toBe(k)                                                         // nothing is written into a busy main
  for (const id of ids) expect(state(id)).toBe('queued')
  const r = await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'Bash' })
  expect(r.additionalContext).toContain('第一則'); expect(r.additionalContext).toContain('第三則'); expect(r.additionalContext).toContain('交給主線')
  for (const id of ids) expect(M().items(x => x.id === id)[0]).toMatchObject({ state: 'bound', prompt_id: p, via_pull: true })
  await kill(g)
  for (const id of ids) expect(state(id)).toBe('queued')
  const g2 = await startMain()                                                          // the next gen: one offer opens its turn, the rest are pulled into it
  const first = ids.find(id => state(id) === 'offered')!
  expect(ids.filter(id => state(id) === 'offered').length).toBe(1)
  const p2 = P()
  await hook(g2, 'UserPromptSubmit', { prompt_id: p2, dids: [first] })
  const stop = await hook(g2, 'Stop', { prompt_id: p2 })                                  // Stop pulls what is left (decision block, same prompt)
  expect(stop.block).toContain('這一輪先不要結束')
  for (const id of ids) expect(state(id)).toBe('bound')
  const again = await hook(g2, 'Stop', { prompt_id: p2 })                                 // nothing left: the aids get the turn's items
  expect(again.block).toBeUndefined(); expect(again.items!.length).toBe(3)
  await hook(g2, 'Stop', { prompt_id: p2, phase: 'final' })
  for (const id of ids) expect(state(id)).toBe('done')
  await kill(g2)
})

test('information never travels alone: a digest with nothing owed to the main is not offered; it rides the next item and is done with it (what it showed is not shown again)', async () => {
  const g = await startMain()
  const k = offers.length
  L.__lanesState().lanes['adam.reflex.9'] = { id: 'adam.reflex.9', kind: 'reflex', n: 9, session_id: 's', thread: 'adam#t-9', status: 'idle', created: '', last: '', transcript: '/x', runs: 1, tokens_in: 0, tokens_out: 0 } as any
  L.__events().open('ev-m1-9', { class: 'alert', owner: 'adam.reflex.9', lane: 'adam.reflex.9', thread: 'adam#t-9', from: 'alert-dispatcher', text: 'mock-api p95 > 2s',
    obligations: [{ kind: 'joey', level: 'line', state: 'met', by: 'notify_joey' }] })
  await M().pump(); await M().tick()
  expect(offers.length).toBe(k)                                                         // an idle main is never woken for a digest
  const id = await joey('今天怎樣？')
  const o = offers.at(-1)!.notif
  expect(o.params.content).toContain('〔車道摘要'); expect(o.params.content).toContain('mock-api p95'); expect(o.params.content).toContain('只附這一次')
  expect(o.params.content.endsWith('今天怎樣？')).toBe(true)
  const [first, dg] = String(o.params.meta.did).split(',')
  expect(first).toBe(id); expect(M().items(r => r.id === dg)[0].kind).toBe('digest')
  const v = L.__events().get('ev-m1-9')!.version
  expect(M().items(r => r.id === dg)[0]).toMatchObject({ events: { 'ev-m1-9': v }, items: 1 })                // the event records it shows, at their versions; how many lines
  expect(M().items(r => r.id === dg)[0].covers).toBeUndefined()
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [o.params.meta.did] })
  expect(state(dg)).toBe('bound')
  await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
  expect(state(dg)).toBe('done'); expect(JSON.parse(readFileSync(join(dir, 'digest.json'), 'utf8')).seen['ev-m1-9']).toBe(v)
  expect(L.__digest()).toBeNull()                                                       // nothing changed since the done digest
  await kill(g)
})

test('inv A(3): a hand-over is an item: taken in and not finished (gen ended) leaves its obligation open; done on Stop meets it (M3 main obligation)', async () => {
  const st = L.__lanesState()
  st.lanes['adam.reflex.7'] = { id: 'adam.reflex.7', kind: 'reflex', n: 7, session_id: 's', thread: 'adam#t-h7', status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  const tok = { runId: 'adam.reflex.7.r1', lane: 'adam.reflex.7', evId: 'ev-h7', closers: [], critical: false, trigger: 'peer', cls: 'peer' } as any
  const g = await startMain()
  await L.callLaneTool(tok, 'handoff_main', { text: 'Eve 要主線答應週五交報告' })
  const ob = () => (L.__events().get('ev-h7')!.obligations as any[]).find(o => o.kind === 'main')
  const item = M().items(r => r.kind === 'handoff' && r.handoff === ob().handoff)[0]
  expect(item.state).toBe('offered')
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [item.id] })
  await kill(g)                                                                         // taken in, never finished
  expect(state(item.id)).toBe('queued'); expect(ob().state).toBe('open')
  const g2 = await startMain()
  const p2 = P(); await hook(g2, 'UserPromptSubmit', { prompt_id: p2, dids: [item.id] }); await hook(g2, 'Stop', { prompt_id: p2, phase: 'final' })
  expect(state(item.id)).toBe('done'); expect(ob().state).toBe('met')
  await kill(g2)
})

test('a daemon restart folds the journal: a queued item is offered once, an item already offered is not offered again', async () => {
  const g = await startMain()
  const a = await joey('重啟前的第一則'), b = await joey('重啟前的第二則')
  expect(state(a)).toBe('offered'); expect(state(b)).toBe('queued')
  const offers2: string[] = []
  const L2 = await import('./lanes.ts?m1-restart') as typeof import('./lanes.ts')
  L2.lanesInit({ ...deps, notifySession: async (sid: string, n: any) => { if (!open.has(sid)) return false; offers2.push(n.params.meta.did); return true } })
  const M2 = L2.__main()
  expect(M2.currentGen()!.id).toBe(String(g.pid))                                       // the live gen comes back from the journal
  L2.__noteMcpPid(g.mcp, g.pid); await M2.pump()
  expect(offers2).toEqual([])                                                           // a is still offered to this gen; b waits for the turn a opens
  const p = P()
  await L2.__mainEvent({ event: 'UserPromptSubmit', pid: g.pid, prompt_id: p, dids: [a] })
  await L2.__mainEvent({ event: 'Stop', pid: g.pid, prompt_id: p, phase: 'final' })
  await sleep(10)
  expect(offers2.length).toBe(1); expect(offers2[0]).toContain(b)                        // b offered exactly once, by the new daemon
  expect(M2.items(r => r.id === a)[0].state).toBe('done')
  g.proc.kill('SIGKILL'); await g.proc.exited; await M2.tick(); await M().tick()
})
