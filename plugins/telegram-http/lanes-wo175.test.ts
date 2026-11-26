// telegram-http 1.58.8 (board WO-175 一, Chiron; his 02:58Z ruling): the Call moments where they are decided, through the real router (LANES_WAKE_DECIDE),
// the real lanes journal tap (onsen-status.ts LanesTap) and CallFacts, with a lane that is a script waiting for the test to end its run, and the main
// played by its hook events. The lines CallFacts hands the spool are what is checked (onsen-calls.test.ts checks the spool itself).
//   a lane: accepted (its full id) → running → completed with its summary; a lane that hands the item to the main: no end from it (a change of hands),
//   the main's turn ends it; the main: accepted → running (bound) → completed once the record shows the turn over; cut and put back → accepted;
//   recorded only → accepted (no session) + completed 「只記錄…」; a scheduled run's receipt outcome; the two old start receipts are gone
import { test, expect, afterAll } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { programView } from './screen-status.ts'
import { CallFacts, DeliveryFacts, LanesTap, type StatusView } from './onsen-status.ts'
import type { CallStateLine } from './onsen-client.ts'

const AGENT = 'wo175test'
process.env.LANES_WAKE_DECIDE = AGENT
process.env.LANES_FLOOD_CONTROL = '0'
process.env.LANES_RECEIPT_STEPS = '0'
const sched: any[] = []
// the agent-inbox daemon as the Telegram daemon reaches it (LANES_INBOX_PORT): the scheduler's answers, and the main's inbox stream taking an offer
const schedSrv = createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
  if (req.url === '/lanes/offer') { res.end(JSON.stringify({ offered: true })); return }
  sched.push({ path: req.url, ...JSON.parse(b || '{}') }); res.end(JSON.stringify({ text: '{"state":"completed"}' })) }) })
await new Promise<void>(r => schedSrv.listen(0, '127.0.0.1', () => r()))
process.env.LANES_INBOX_PORT = String((schedSrv.address() as any).port)
const L = await import('./lanes.ts?wo175') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo175-'))
process.env.LANES_DIR = dir
writeFileSync(join(dir, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
const GO = join(dir, 'go')
const bin = join(dir, 'lane.py')
// each run waits for its own lane's go file (the lane id is in its prompt's 〔車道資訊〕)
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, re, sys, time
a = sys.argv
p = a[a.index('-p') + 1] if '-p' in a else ''
m = re.search(r'lane id：([^；）]+)', p)
go = '${GO}-' + (m.group(1) if m else 'x')
t0 = time.time()
while time.time() - t0 < 30:
    if os.path.exists(go):
        os.remove(go); break
    time.sleep(0.02)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restoreBin = L.__setClaudeBin(bin)
L.__setRetryBackoff(20)
let program: StatusView = { state: 'idle', detail: { queued_joey: 0 }, last_activity_at: new Date().toISOString() }
const sent: string[] = [], mesh: any[] = []
L.__setMeshSend(async b => { mesh.push(b); return { text: `sent to ${b.to}`, msgId: 75000 + mesh.length, delivered: true } })
L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false,
  registryNames: () => ['chiron', 'eve', 'sonn'], sendBot: async (_c: string, text: string) => { sent.push(text); return 700 + sent.length }, joeyChatId: () => '1',
  mainStatus: () => programView(program), notifySession: async () => true, streamOpen: () => true } as any)
L.__setMainConnected('mcp-main')
const lines: CallStateLine[] = []
const calls = new CallFacts({ sink: l => lines.push(l) })
const tap = new LanesTap({ facts: new DeliveryFacts({ agent: AGENT, sink: () => {} }), joey: () => null, gen: () => L.mainGenRow(), changed: () => {}, calls, callOf: id => L.callOfEvent(id) })
L.observeLanes({ journal: (r, l) => tap.journal(r, l), mainEvent: b => tap.mainEvent(b), calls })
const acks: string[] = []
L.__setAckHook(run => acks.push(run))
afterAll(() => { schedSrv.close(); L.__setClaudeBin(restoreBin); L.__setAckHook(null); L.__setMeshSend(null)
  for (const k of ['LANES_WAKE_DECIDE', 'LANES_FLOOD_CONTROL', 'LANES_RECEIPT_STEPS', 'LANES_INBOX_PORT']) delete process.env[k] })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const of = (ev: string) => lines.filter(l => l.event === ev).map(l => `${l.body.state}:${l.body.session_id ?? '-'}${l.body.result ? `:${JSON.stringify(l.body.result)}` : ''}`)
let n = 0
const call = (o: Record<string, unknown> = {}) => { n += 1; const id = String(175000 + n); return { id: `mesh-${id}`, source: 'mesh', from: 'eve', verified: true, text: `WO-175 測試件 ${n}`,
  btcc_msg_id: id, item_kind: 'peer_call', line: 'call', call_id: String(300 + n), meta: { user: 'eve' }, notif: { method: 'notifications/claude/channel', params: { content: `WO-175 測試件 ${n}`, meta: { user: 'eve', btcc_msg_id: id } } }, ...o } as any }
async function start(ev: any): Promise<{ lane: string; tok: any }> {
  const d = await L.routeEvent(ev)
  expect(d.target).toBe('lane')
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  return { lane: d.lane!, tok: L.__runTok(d.lane!)! }
}
async function end(lane: string) { writeFileSync(`${GO}-${lane}`, 'ok'); expect(await until(() => !L.__runTok(lane))).toBe(true); await sleep(40) }
const pid = process.pid
let p = 0
const itemOf = (ev: string) => L.__main().items((r: any) => r.event === ev).at(-1)!
const stop = async () => { await L.__mainEvent({ event: 'Stop', pid, prompt_id: `p175-${p}` }); await L.__mainEvent({ event: 'Stop', pid, prompt_id: `p175-${p}`, phase: 'final' }) }

test('a lane: accepted with its full id at the routing, running when its run starts, completed at its end with its own summary (the receipt\'s line)', async () => {
  const ev = call()
  const { lane, tok } = await start(ev)
  expect(lane).toMatch(new RegExp(`^${AGENT}\\.reflex\\.\\d+$`))
  expect(await until(() => of(ev.id).length >= 2)).toBe(true)
  await L.callLaneTool(tok, 'reply_agent', { to: 'eve', text: '查到了：14 次' })
  await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: 'Eve 問 5xx，14 次，已回' })
  await L.callLaneTool(tok, 'receipt', { outcome: 'done', happened: 'Eve 問上週 5xx', did: '查到 14 次，回給 Eve', promised: '無', needs_main: '無' })
  await end(lane)
  expect(of(ev.id)).toEqual([`accepted:${lane}`, `running:${lane}`, `completed:${lane}:{"body":{"format":"markdown","text":"Eve 問上週 5xx；查到 14 次，回給 Eve"}}`])
  expect(lines.filter(l => l.event === ev.id).every(l => l.call_id === ev.call_id && l.kind === 'peer_call')).toBe(true)
})

test('the item\'s call id rides into the lane (its record) and names the Call; an item with none (before its Call exists) reports nothing', async () => {
  const none = call({ call_id: undefined })
  const r0 = await start(none)
  await L.callLaneTool(r0.tok, 'notify_joey', { outcome: 'normal', text: 't' }); await L.callLaneTool(r0.tok, 'reply_agent', { to: 'eve', text: 'ok' })
  await L.callLaneTool(r0.tok, 'receipt', { outcome: 'done', happened: 'h', did: 'd', promised: '無', needs_main: '無' })
  await end(r0.lane)
  expect(of(none.id)).toEqual([])
  const ev = call({ call_id: '344' })
  const { lane, tok } = await start(ev)
  expect(L.callOfEvent(ev.id)).toEqual({ kind: 'peer_call', id: '344' })
  await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: 't' }); await L.callLaneTool(tok, 'reply_agent', { to: 'eve', text: 'ok' })
  await L.callLaneTool(tok, 'receipt', { outcome: 'done', happened: 'h', did: 'd', promised: '無', needs_main: '無' })
  await end(lane)
  expect(lines.filter(l => l.event === ev.id).every(l => l.call_id === '344')).toBe(true)
})

test('a lane that hands the item to the main: no end from the lane (a change of hands, not failed); the main\'s turn takes it and ends it', async () => {
  const ev = call()
  const { lane, tok } = await start(ev)
  await L.callLaneTool(tok, 'handoff_main', { text: 'Eve 要改設定，要主線決定' })
  await end(lane)
  expect(of(ev.id)).toEqual([`accepted:${lane}`, `running:${lane}`])
  const it = itemOf(ev.id)
  expect(it).toBeTruthy()
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: `p175-${++p}`, dids: [it.id] })
  // Onsen took the change of hands from the lane's exit row (back to accepted, recipient main): the main's turn is its running
  expect(of(ev.id)).toEqual([`accepted:${lane}`, `running:${lane}`, 'running:main'])
  await stop()
  calls.statusRecord('idle')
  expect(of(ev.id)).toEqual([`accepted:${lane}`, `running:${lane}`, 'running:main', 'completed:main'])
})

test('the main (an unverified caller goes to the main): accepted main → running when bound into its turn → completed once the record shows the turn over; a turn the Stop hook sent back does not end it', async () => {
  const ev = call({ verified: false })
  const d = await L.routeEvent(ev)
  expect(d.target).toBe('main')
  expect(of(ev.id)).toEqual(['accepted:main'])
  expect(await until(() => itemOf(ev.id)?.state === 'offered', 2000)).toBe(true)
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: `p175-${++p}`, dids: [itemOf(ev.id).id] })
  expect(of(ev.id)).toEqual(['accepted:main', 'running:main'])
  await stop()
  calls.statusRecord('busy')                                                               // the Stop was sent back: the record still shows the turn
  expect(of(ev.id)).toEqual(['accepted:main', 'running:main'])
  calls.statusRecord('idle')
  expect(of(ev.id)).toEqual(['accepted:main', 'running:main', 'completed:main'])
  expect(acks).toEqual([])
})

test('the main\'s turn cut (Esc) with the item put back for the next delivery: accepted again (the one step back), running again when a turn takes it', async () => {
  const ev = call({ verified: false })
  await L.routeEvent(ev)
  expect(await until(() => itemOf(ev.id)?.state === 'offered', 2000)).toBe(true)
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: `p175-${++p}`, dids: [itemOf(ev.id).id] })
  L.__journal().write('msg', itemOf(ev.id).id, 'queued', { reason: 'interrupted', gen: null, prompt_id: null, via_pull: null })   // the Esc wrap-up's line
  expect(of(ev.id)).toEqual(['accepted:main', 'running:main', 'accepted:main'])
  L.__journal().write('msg', itemOf(ev.id).id, 'bound', { gen: 'x', prompt_id: `p175-${++p}` })
  expect(of(ev.id)).toEqual(['accepted:main', 'running:main', 'accepted:main', 'running:main'])
  L.__journal().write('msg', itemOf(ev.id).id, 'done', {})
  calls.statusRecord('idle')
  expect(of(ev.id).at(-1)).toBe('completed:main')
  await stop()
})

test('recorded only (a no_reply call with no thread of ours): accepted with no session and completed at once, 「只記錄，沒有交給任何一條 session」', async () => {
  const ev = call({ no_reply: true })
  const d = await L.routeEvent(ev)
  expect(d.target).toBe('ledger')
  expect(of(ev.id)).toEqual(['accepted:-', 'completed:-:{"body":{"format":"markdown","text":"只記錄，沒有交給任何一條 session"}}'])
})

test('not Calls: a reply (reply_to) and a daemon\'s silent notice send nothing', async () => {
  const a = call({ reply_to_id: '175001', no_reply: true }), b = call({ urgency: 'silent', no_reply: true })
  await L.routeEvent(a); await L.routeEvent(b)
  expect(of(a.id)).toEqual([]); expect(of(b.id)).toEqual([])
})

test('a scheduled run in a lane: running is the start receipt (no auto-ack); its receipt is the run\'s Call (completed, outcome nothing_to_do, the line), not BTCC\'s /complete', async () => {
  const run = '9175'
  const ev = { id: 'mesh-sch-175', source: 'mesh', from: 'scheduler', verified: true, text: `[scheduled][disk-check][run:${run}][P3][routine] disk-check`, item_kind: 'scheduled', call_id: '4175',
    meta: { user: 'scheduler', run_id: run }, refs: { run_id: run, schedule: '12' }, notif: { method: 'notifications/claude/channel', params: { content: 'disk-check', meta: { run_id: run } } } } as any
  const { lane, tok } = await start(ev)
  expect(await until(() => of(ev.id).length >= 2)).toBe(true)
  await L.callLaneTool(tok, 'notify_joey', { outcome: 'normal', text: '磁碟 41%，沒事' })
  expect(await L.callLaneTool(tok, 'receipt', { run_id: run, outcome: 'nothing-to-do', happened: '例行磁碟檢查', did: '41%，沒事', promised: '無', needs_main: '無' }))
    .toBe(`receipt recorded; scheduler: {"ok":true,"state":"completed","outcome":"nothing-to-do","call_id":"4175","via":"onsen"}`)
  await end(lane)
  // the receipt is the run's Call: completed with the receipt's outcome and its line (the note BTCC got before), at the receipt; nothing to BTCC
  expect(of(ev.id)).toEqual([`accepted:${lane}`, `running:${lane}`, `completed:${lane}:{"outcome":"nothing_to_do","body":{"format":"markdown","text":"例行磁碟檢查"}}`])
  expect(lines.find(l => l.event === ev.id)!.call_id).toBe('4175')
  expect(sched.filter(x => x.run_id === run)).toEqual([])                                   // no ack, no /complete of its own
  expect((L.__events().get(ev.id)?.obligations ?? []).find((o: any) => o.kind === 'receipt')).toMatchObject({ state: 'met', run_id: run })
  expect(acks).toEqual([])
})

test('a scheduled run the main takes into its turn: no M1 start receipt (its Call\'s running is it)', async () => {
  const run = '9176'
  const ev = { id: 'mesh-sch-176', source: 'mesh', from: 'scheduler', verified: false, text: `[scheduled][x][run:${run}] x`, item_kind: 'scheduled', call_id: '4176',
    meta: { user: 'scheduler', run_id: run }, refs: { run_id: run }, notif: { method: 'notifications/claude/channel', params: { content: 'x', meta: { run_id: run } } } } as any
  const d = await L.routeEvent(ev)
  expect(d.target).toBe('main')
  expect(await until(() => itemOf(ev.id)?.state === 'offered', 2000)).toBe(true)
  await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: `p175-${++p}`, dids: [itemOf(ev.id).id] })
  expect(of(ev.id)).toEqual(['accepted:main', 'running:main'])
  expect(acks).toEqual([])
  await stop()
})
