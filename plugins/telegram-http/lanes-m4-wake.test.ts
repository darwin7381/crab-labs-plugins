// M4, the one wake rule: the main is woken iff M2 says it is idle AND M3 has something owed to the main that M1 has not done; waking IS M1 offering
// that item. Everything else is information and rides the next offer or pull (the digest). The failures of class C (002b, 002d, 002m aid c, 002n E02,
// inv C(4)) are played here with a stand-in main process (its hook events) and a lane script. No model, no network.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { createServer } from 'http'
process.env.LANES_FLOOD_CONTROL = '0'
// the scheduler, as the inbox daemon reaches it (POST /lanes/scheduler): PL2, a receipt is met on the scheduler's answer
const schedSrv = createServer((req, res) => { req.resume(); req.on('end', () => res.end(JSON.stringify({ text: '{"state":"completed"}' }))) })
await new Promise<void>(r => schedSrv.listen(0, '127.0.0.1', () => r()))
process.env.LANES_INBOX_PORT = String((schedSrv.address() as any).port)
const L = await import('./lanes.ts?m4-test') as typeof import('./lanes.ts')
delete process.env.LANES_INBOX_PORT
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-m4-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const GO = join(dir, 'go'), bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, time
t0 = time.time()
while time.time() - t0 < 30 and not os.path.exists('${GO}'): time.sleep(0.02)
try: os.remove('${GO}')
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
const offers: any[] = [], open = new Set<string>(), sent: string[] = []
L.__setMeshSend(async b => ({ text: `sent to ${b.to}`, msgId: 80000 + Math.floor(Math.random() * 1000), delivered: true }))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async (sid: string, notif: any) => { if (!open.has(sid)) return false; offers.push(notif); return true }, streamOpen: (sid: string) => open.has(sid),
  sendBot: async (_c: string, text: string) => { sent.push(text); return 100 + sent.length }, joeyChatId: () => '1' } as any)
L.__setWallProbe(3_600_000)
const procs: any[] = []
afterAll(() => { schedSrv.close(); try { writeFileSync(GO, 'ok') } catch {}; for (const p of procs) { try { p.kill('SIGKILL') } catch {} } L.__setClaudeBin(restore); L.__setWallProbe(300_000); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const journal = (): any[] => readFileSync(join(dir, 'lanes', 'state.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
const M = () => L.__main()
const sid = randomUUID(), proc = Bun.spawn(['sleep', '600']); procs.push(proc)
const g = { pid: proc.pid, mcp: `mcp-${proc.pid}` }
writeFileSync(join(dir, 'main-expected'), sid)
open.add(g.mcp); L.__noteMcpPid(g.mcp, g.pid)
await L.__mainEvent({ event: 'SessionStart', pid: g.pid, session_id: sid })
const hook = (event: string, o: object = {}) => L.__mainEvent({ event, pid: g.pid, session_id: sid, ...o })
let np = 0, n = 0
const P = () => `p4-${++np}`
const mk = (from: string, text: string) => ({ id: `mesh-m4-${++n}`, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
async function laneDoes(ev: any, f: (tok: any) => Promise<void>): Promise<string> {
  const d = await L.routeEvent(ev)
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  await f(L.__runTok(d.lane!))
  writeFileSync(GO, 'ok')
  expect(await until(() => !L.__runTok(d.lane!))).toBe(true)
  await sleep(30)
  return ev.id
}
/** the main takes what it was offered and ends the turn with Stop (pulling whatever is left) */
async function mainTurn(): Promise<void> {
  const off = M().items(r => r.state === 'offered')
  const p = P()
  await hook('UserPromptSubmit', { prompt_id: p, dids: off.map(r => r.id) })
  await hook('Stop', { prompt_id: p }); await hook('Stop', { prompt_id: p, phase: 'final' })
}

test('002m aid (c) 1fb35ef, 002b, A06/C03: lane events that end with their obligations met never wake an idle main; the next Joey message carries them', async () => {
  expect(M().mainPhase()).toBe('idle')
  const k = offers.length
  const a = await laneDoes({ ...mk('scheduler', '[scheduled][backup-check][run:61][P3][routine] 查備份'), meta: { run_id: '61' } }, async t => {
    await L.callLaneTool(t, 'notify_joey', { outcome: 'normal', text: '備份正常' }); await L.callLaneTool(t, 'receipt', { outcome: 'done', run_id: '61', happened: '備份檢查', did: '一切正常', promised: '無', needs_main: '無' }) })
  const b = await laneDoes(mk('eve', '維護幾點？'), async t => {
    await L.callLaneTool(t, 'reply_agent', { to: 'eve', text: '02:00' }); await L.callLaneTool(t, 'notify_joey', { outcome: 'normal', text: 'Eve 問維護，回 02:00' }) })
  await M().tick()
  expect(offers.length).toBe(k)                                                             // nothing was offered: the idle main was not woken
  for (const id of [a, b]) expect(journal().some(l => l.rec === 'wake' && l.id === id && l.state === 'no_wake')).toBe(true)
  const meta = { chat_id: '1', message_id: '777', user: 'joey_lab' }
  await L.routeEvent({ id: 'tg-1-777', source: 'telegram', from: 'joey', text: '今天怎樣？', meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: '今天怎樣？', meta } } } as any)
  await M().pump()
  expect(offers.length).toBe(k + 1)
  expect(offers.at(-1).params.content).toContain('〔車道摘要'); expect(offers.at(-1).params.content).toContain('今天怎樣？')
  await mainTurn()
})

test('002d: a line that rings Joey (a critical alert the lane reported) is information for the main: it does not wake it', async () => {
  const k = offers.length
  await laneDoes(mk('alert-dispatcher', '[P1] mock-api 全掛'), async t => { await L.callLaneTool(t, 'notify_joey', { outcome: 'normal', text: 'mock-api 已重啟恢復' }) })
  await M().tick()
  expect(sent.at(-1)).toContain('mock-api 已重啟恢復')
  expect(offers.length).toBe(k)
})

test('C2: handoff_main while the main is idle is offered at once (one wake); while it is busy it is pulled at the next tool boundary, never pushed; one wake each, never two', async () => {
  const k = offers.length
  const a = await laneDoes(mk('eve', '能答應週五給報表嗎？'), async t => { await L.callLaneTool(t, 'handoff_main', { text: 'Eve 要週五報表，要主線決定' }) })
  expect(offers.length).toBe(k + 1); expect(offers.at(-1).params.content).toContain('Eve 要週五報表')
  const item = M().items(r => r.kind === 'handoff' && r.event === a)[0]
  expect(item.state).toBe('offered')
  expect(journal().filter(l => l.rec === 'wake' && l.state === 'wake' && (l.id === item.id || l.id === a)).length).toBe(2)   // the M3 decision and the M1 offer
  const p = P()
  await hook('UserPromptSubmit', { prompt_id: p, dids: [item.id] })                          // the main is busy with it now
  const b = await laneDoes(mk('eve', '另外，能延後部署嗎？'), async t => { await L.callLaneTool(t, 'handoff_main', { text: 'Eve 要延後部署，要主線決定' }) })
  expect(offers.length).toBe(k + 1)                                                          // never pushed into a busy main
  const r = await hook('PostToolUse', { prompt_id: p, tool_name: 'Bash' })
  expect(r.additionalContext).toContain('Eve 要延後部署')
  expect(M().items(x => x.kind === 'handoff' && x.event === b)[0]).toMatchObject({ state: 'bound', prompt_id: p })
  await hook('Stop', { prompt_id: p, phase: 'final' })
  for (const id of [a, b]) expect((L.__events().get(id)!.obligations as any[]).find(o => o.kind === 'main').state).toBe('met')
})

test('inv C(4), PL4: a walled main (its own wall) gets nothing owed until its retry time; then the wake is the probe offer, once; the lanes\' wall never wakes it', async () => {
  const p0 = P(); await hook('UserPromptSubmit', { prompt_id: p0 }); await hook('StopFailure', { prompt_id: p0, error: 'rate_limit', reason: '429' })
  expect(M().mainPhase()).toBe('walled')
  const k = offers.length
  const st = L.__lanesState()                                                                 // a lane run that was already going hands over
  st.lanes['adam.reflex.99'] = { id: 'adam.reflex.99', kind: 'reflex', n: 99, session_id: 's', thread: 'adam#t-99', status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  const a = 'ev-m4-walled'
  L.__events().open(a, { class: 'peer', owner: 'adam.reflex.99', lane: 'adam.reflex.99', from: 'eve', text: 'Eve 要權限', obligations: [{ kind: 'peer', level: 'answer', to: 'eve' }] })   // the router recorded it
  await L.callLaneTool({ runId: 'adam.reflex.99.r1', lane: 'adam.reflex.99', evId: a, closers: [], critical: false, trigger: 'peer', cls: 'peer' } as any, 'handoff_main', { text: 'Eve 要權限' })
  expect(offers.length).toBe(k)
  expect(journal().some(l => l.rec === 'wake' && l.id === a && l.state === 'no_wake' && /walled/.test(l.reason))).toBe(true)
  L.__wallUp('rate_limit', 'lane 429'); await L.__wallDown(); await sleep(20)                // the lanes' wall up and down: not the main's signal
  expect(offers.length).toBe(k); expect(M().mainPhase()).toBe('walled')
  L.__journal().write('main', String(g.pid), 'walled', { retry_at: Date.now() - 1 })          // its retry time comes
  await M().tick()
  expect(offers.length).toBe(k + 1); expect(offers.at(-1).params.content).toContain('Eve 要權限')
  await M().tick(); expect(offers.length).toBe(k + 1)                                         // once
  await mainTurn()
  expect(M().mainPhase()).toBe('idle')
})

test('PL7 P20: the fan-out synthesis is owed to the main through its M3 hand-over: offered when it is idle; an item whose event owes the main nothing is never offered; information never alone', async () => {
  const k = offers.length
  M().enqueue('carry', { method: 'notifications/claude/channel', params: { content: '〔孤兒〕沒有任何義務', meta: { user: 'lanes' } } })   // no M3 obligation: not owed (P20)
  M().enqueue('joey', { method: 'notifications/claude/channel', params: { content: '沒有記錄的訊息', meta: {} } }, { event: 'ev-m4-none' })
  await M().pump(); await M().tick()
  expect(offers.length).toBe(k)
  const st = L.__lanesState(), syn = 'adam.synthesis.7'
  st.lanes[syn] = { id: syn, kind: 'synthesis', n: 7, session_id: 's', thread: 'adam#t-syn7', status: 'running', created: '', last: '', transcript: '/x', runs: 0, tokens_in: 0, tokens_out: 0 } as any
  st.fanouts = { 'fo-m4': { id: 'fo-m4', brief: '三塊', tasks: ['a', 'b', 'c'], members: [], results: {}, created: '' } } as any
  L.__events().open('ev-syn-m4', { class: 'joey', owner: syn, lane: syn, from: 'main', text: '三塊', obligations: [] })   // the router recorded the synthesis event
  expect(await L.callLaneTool({ runId: `${syn}.r1`, lane: syn, evId: 'ev-syn-m4', closers: [], critical: false, trigger: 'synthesis', cls: 'synthesis', synthesis: 'fo-m4' } as any, 'deliver_synthesis', { text: '三塊都好' })).toContain('queued for the main')
  await sleep(10)
  expect(offers.length).toBe(k + 1); expect(offers.at(-1).params.content).toContain('三塊都好')
  await mainTurn()
  const m = offers.length
  M().enqueue('digest', { method: 'notifications/claude/channel', params: { content: '〔車道摘要〕只有資訊', meta: {} } })
  await M().pump(); await M().tick()
  expect(offers.length).toBe(m)                                                              // information alone wakes nobody
})

test('PL7 P20, 002w D: the router\'s fallback (the router threw) gives the main the event\'s own record from the one builder (toMain): a main obligation and what its class owes; its item is owed like any hand-over, done meets it', async () => {
  const k = offers.length
  const meta = { user: 'joey_lab', message_id: '4040', chat_id: '1' }
  L.toMainDirect({ id: 'tg-1-4040', source: 'telegram', from: 'joey', text: '路由器壞掉時的訊息', meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: '路由器壞掉時的訊息', meta } } } as any)
  await sleep(10)
  expect(offers.length).toBe(k + 1)
  const item = M().items(r => r.state === 'offered').at(-1)!
  const ev = L.__events().get(String(item.event))!
  expect(ev).toMatchObject({ id: 'tg-1-4040', owner: 'main', class: 'joey' })                    // 002w D: its own record (2a936a7: a direct-… record, no Joey line)
  expect((ev.obligations as any[]).find(o => o.kind === 'joey')).toMatchObject({ state: 'handed' })
  await mainTurn()
  expect((L.__events().get(ev.id)!.obligations as any[])[0]).toMatchObject({ kind: 'main', state: 'met' })
})
