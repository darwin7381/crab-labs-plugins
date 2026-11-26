// WO-177 (Chiron's ticket; Joey TG chiron:2485 「你是不是把它搞得到處都是補丁很複雜？」, 2515, 2547): 「can the main take an item now」 has one answer, the
// status record (server.ts currentStatus(), handed in as mainStatus). The router runs in this process (lanes.ts, role tg, LANES_WAKE_DECIDE on for this
// agent); the record is composed here as server.ts does: publishView(the judge's verdict, the regions, statusOf's view).
//   一  the offer, the offer's lease and the stuck alarms ask the record: a menu, a compaction, the wall hold the item in `queued`; it is offered the moment
//       the record turns idle (mainStatusChanged), once; the lease counts only the time the record says idle; no stuck alarm while the record names its own
//       blocker (waiting, walled). No record here (Onsen step 3 off): M2 decides as before
//   三  a decided route row carries the decision's urgency (the wake row's: a no_reply call is not recorded silent while it was decided as interrupt); the
//       observation's queue: pending = still queued (held), unread_by_member = offered, not yet in a turn
//   六  a lane run's open tool (its own stream) reaches runningLanes() and the observation's doing
import { test, expect, afterAll } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { composeRecord, programView, publishView, regions, type ScreenVerdict } from './screen-status.ts'
import type { StatusView } from './onsen-status.ts'
import { wakeItem } from './onsen-wake.ts'
import { checkObservation } from './test-fixtures/status-v1-check.ts'

const AGENT = 'wo177test'
process.env.LANES_WAKE_DECIDE = `someone-else,${AGENT}`
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?wo177') as typeof import('./lanes.ts')
const M = await import('./lanes-main.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo177-'))
process.env.LANES_DIR = dir
writeFileSync(join(dir, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
const R = '─'.repeat(80)
const screen = (above: string[]) => ['', ...above, '', R, '❯ ', R, '  Opus 5.5 · 7d 71%', '  ⏵⏵ bypass permissions on', ''].join('\n')
const MENU = ['', '   Select model', '   ❯ 1. Default (recommended)', '     2. Opus', '   Enter to set as default · Esc to cancel', ''].join('\n')
const IDLE = screen(['⏺ Done.', '', '✻ Worked for 3s · done 1:37 AM'])
const COMPACT = screen(['✻ Compacting conversation… (12s)'])
let verdict: ScreenVerdict | null = null, shown = IDLE, noRecord = false
let program: StatusView = { state: 'idle', detail: { queued_joey: 0 }, last_activity_at: new Date().toISOString() }
const record = (): StatusView | null => noRecord ? null : verdict ? publishView(verdict, regions(shown), program) : programView(program)
const V = (state: ScreenVerdict['state'], menu: ScreenVerdict['menu'] = 'none'): ScreenVerdict => ({ state, menu, p: 0.9, by: 'jev' })
const sent: string[] = []
const SCRIPT = join(dir, 'lane-tool.sh')
// a lane run (stands in for `claude -p … --output-format stream-json`): one Bash call open for 0.8 s, its result, then the run's result
writeFileSync(SCRIPT, `#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"11111111-2222-4333-8444-555555555555"}'
echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"tu-1","name":"Bash","input":{"command":"sleep 60"}}],"usage":{}}}'
sleep 0.8
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":"done"}]}}'
sleep 0.6
echo '{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":"done"}'
exit 0
`)
chmodSync(SCRIPT, 0o755)
const restoreBin = L.__setClaudeBin(SCRIPT)
L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false,
  registryNames: () => ['chiron', 'eve'], sendBot: async (_c: string, text: string) => { sent.push(text); return 900 + sent.length }, joeyChatId: () => '1',
  mainStatus: record, notifySession: async () => true, streamOpen: () => true } as any)
L.__setMainConnected('mcp-main')
afterAll(() => { delete process.env.LANES_WAKE_DECIDE; delete process.env.LANES_FLOOD_CONTROL; L.__setClaudeBin(restoreBin); M.__setOfferLeaseMs(20_000); M.__setMainStuckMs(600_000) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(10) } return f() }
const jsonl = (f: string): any[] => { try { return readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const rowOf = (id: string) => jsonl('routing.jsonl').filter(r => r.event === id).at(-1)
const pid = process.pid
let p = 0, n = 0
const stop = async () => { await L.__mainEvent({ event: 'Stop', pid, prompt_id: `p177-${p}` }); await L.__mainEvent({ event: 'Stop', pid, prompt_id: `p177-${p}`, phase: 'final' }) }
function joey(text: string): any {
  n += 1
  const meta = { chat_id: '1', message_id: String(17700 + n), user: 'joey_lab' }
  return { id: `tg-1-${17700 + n}`, source: 'telegram', from: 'joey', text, meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: text, meta } } }
}
const itemOf = (ev: string) => L.__main().items((r: any) => r.event === ev)[0]
const lines = (id: string) => jsonl('lanes/state.jsonl').filter(l => l.id === id)
const offeredLines = (id: string) => lines(id).filter(l => l.rec === 'msg' && l.state === 'offered')
/** the record has changed (server.ts calls this at each record it hands out whose member state or interruption differs) */
const changed = () => L.mainStatusChanged()
const idleNow = () => { verdict = V('idle'); shown = IDLE; program = { state: 'idle', detail: { queued_joey: 0 }, last_activity_at: new Date().toISOString() }; changed() }
/** the item opens a turn: its UserPromptSubmit names it (did), then the turn ends */
async function take(ev: string) { const it = itemOf(ev); await L.__mainEvent({ event: 'UserPromptSubmit', pid, prompt_id: `p177-${++p}`, dids: [it.id] }); await stop() }

test('一 a /model menu open while the main is idle: the decision says held:waiting and the item is held (queued, never offered, the queue counts it pending); the menu closes → offered at that change, once', async () => {
  await stop()
  shown = MENU; verdict = V('waiting_for_human', 'model_picker')
  program = { state: 'idle', detail: { queued_joey: 0, dialog_open: true }, last_activity_at: new Date().toISOString() }
  changed()
  expect(L.__main().mainPhase()).toBe('idle')                               // M2 sees no menu (no hook fires for it)
  expect(L.mainCanTake()).toBe(false)
  expect(L.__main().deliveryNow()).toBe('waiting')
  const m = joey('選單開著時的一則')
  await L.routeEvent(m)
  expect(rowOf(m.id)).toMatchObject({ decided_by: 'new', wake_target: 'held:waiting', wake_urgency: 'interrupt' })
  await sleep(10)
  expect(itemOf(m.id).state).toBe('queued')
  expect(offeredLines(itemOf(m.id).id)).toHaveLength(0)
  expect(lines(itemOf(m.id).id).find(l => l.rec === 'wake')).toMatchObject({ state: 'no_wake', reason: 'main waiting (the status record): offered when the record says it can take it' })
  expect(L.mainQueueCounts()).toEqual({ pending: 1, unread_by_member: 0 })
  await L.__main().tick()                                                  // the 5 s tick changes nothing while the menu is open
  expect(itemOf(m.id).state).toBe('queued')
  // the menu closes (the duty officer's Esc): the record turns idle; the item goes out at that change, not at the next tick
  const t0 = Date.now()
  idleNow()
  expect(await until(() => itemOf(m.id).state === 'offered', 1000)).toBe(true)
  expect(Date.now() - t0).toBeLessThan(1000)
  expect(L.mainQueueCounts()).toEqual({ pending: 0, unread_by_member: 1 })
  expect(lines(itemOf(m.id).id).filter(l => l.rec === 'wake').at(-1)).toMatchObject({ state: 'wake' })
  await take(m.id)
  expect(itemOf(m.id).state).toBe('done')
  expect(offeredLines(itemOf(m.id).id)).toHaveLength(1)                     // one offer: one prompt, nothing cut as interrupted
  expect(lines(itemOf(m.id).id).some(l => l.reason === 'interrupted')).toBe(false)
})

test('一 the offer\'s lease counts only the time the record says the main can take it: an offer out before a menu opened is not offered again while the menu is open; from the record\'s idle on, the lease runs as before', async () => {
  M.__setOfferLeaseMs(150)
  idleNow()
  const m = joey('交出去之後選單才開')
  await L.routeEvent(m)
  expect(await until(() => itemOf(m.id).state === 'offered', 500)).toBe(true)
  shown = MENU; verdict = V('waiting_for_human', 'model_picker'); changed()
  await sleep(400)
  await L.__main().tick()
  expect(itemOf(m.id).state).toBe('offered')                               // Claude Code holds the copy until the menu closes: no second copy
  expect(lines(itemOf(m.id).id).some(l => l.reason === 'offer_untaken')).toBe(false)
  idleNow()                                                                 // the lease starts now
  await L.__main().tick()
  expect(lines(itemOf(m.id).id).some(l => l.reason === 'offer_untaken')).toBe(false)
  await sleep(250)
  await L.__main().tick()                                                   // idle for longer than the lease, still not taken: lost on the client side, written once more
  expect(lines(itemOf(m.id).id).some(l => l.reason === 'offer_untaken')).toBe(true)
  expect(await until(() => itemOf(m.id).state === 'offered', 500)).toBe(true)
  expect(offeredLines(itemOf(m.id).id)).toHaveLength(2)
  M.__setOfferLeaseMs(20_000)
  await take(m.id)
})

test('一 no stuck alarm while the record names its own blocker: items held past MAIN_STUCK_MS behind a menu, an offer untaken behind a menu: nobody is told', async () => {
  M.__setMainStuckMs(200)
  idleNow()
  const a = joey('先交出去')
  await L.routeEvent(a)
  expect(await until(() => itemOf(a.id).state === 'offered', 500)).toBe(true)
  shown = MENU; verdict = V('waiting_for_human', 'model_picker'); changed()
  const b = joey('選單開著時進來')
  await L.routeEvent(b)
  const before = sent.length
  await sleep(350)
  await L.__main().tick(); await L.__main().tick()
  expect(sent.slice(before).filter(t => /主線疑似卡死|主線收不到訊息|主線不在/.test(t))).toEqual([])
  expect(itemOf(b.id).state).toBe('queued')
  // the same wait with the wall in the record (usage_wall.py's: statusOf's detail.walled while M2 is idle): no alarm either
  verdict = null; program = { state: 'idle', detail: { queued_joey: 0, walled: { until: new Date(Date.now() + 3600_000).toISOString(), kind: 'session' } }, last_activity_at: new Date().toISOString() }
  changed()
  expect(L.__main().deliveryNow()).toBe('walled')
  await sleep(250)
  await L.__main().tick()
  expect(sent.slice(before).filter(t => /主線疑似卡死|主線收不到訊息|主線不在/.test(t))).toEqual([])
  expect(itemOf(b.id).state).toBe('queued')
  expect(offeredLines(itemOf(b.id).id)).toHaveLength(0)
  // the wall lifts: a's copy opens its turn, and b (queued) is pulled into that turn at its Stop (a turn's own pull is the main's hook, unchanged)
  M.__setMainStuckMs(600_000)
  idleNow()
  await take(a.id)
  expect(['bound', 'done']).toContain(itemOf(b.id).state)
  expect(offeredLines(itemOf(b.id).id)).toHaveLength(0)
  await stop()
})

test('一 a compaction while the main is idle (no hook for it beyond PreCompact): the item waits for the compaction to end, then goes once', async () => {
  idleNow()
  shown = COMPACT; verdict = V('compacting'); changed()
  expect(L.__main().deliveryNow()).toBe('compacting')
  const m = joey('壓縮中進來的')
  await L.routeEvent(m)
  await sleep(20)
  expect(itemOf(m.id).state).toBe('queued')
  idleNow()
  expect(await until(() => itemOf(m.id).state === 'offered', 1000)).toBe(true)
  await take(m.id)
  expect(offeredLines(itemOf(m.id).id)).toHaveLength(1)
})

test('② (Chiron 03:41Z) the record says working while M2 is idle (a turn the Stop hook sent back, no hook since): items held past MAIN_STUCK_MS — the push stays, its sentence says what the record shows (not the channel)', async () => {
  M.__setMainStuckMs(200)
  idleNow()
  const WORK = screen(['⏺ Checking once more.', '', '✻ Pondering… (2m 3s · ↓ 4.1k tokens)'])
  shown = WORK; verdict = V('working'); changed()
  expect(L.__main().mainPhase()).toBe('idle')
  expect(L.mainCanTake()).toBe(false)
  const a = joey('畫面在忙時進來的一則'), b = joey('第二則')
  await L.routeEvent(a); await L.routeEvent(b)
  const before = sent.length
  await sleep(300)
  await L.__main().tick()
  const told = sent.slice(before).filter(t => /主線/.test(t))
  expect(told.length).toBe(1)
  expect(told[0].split('\n').at(-1)).toBe('主線的畫面顯示在處理中，但 1 分鐘沒有任何回合事件；有 2 件排著還沒交進去。')   // the lab's 200 ms MAIN_STUCK_MS; 10 分鐘 at 600 s
  expect(told.join('')).not.toContain('通道')
  expect(itemOf(a.id).state).toBe('queued')
  // the record turns idle: both go in, once; with MAIN_STUCK_MS 600 s the same words say 10 分鐘
  M.__setMainStuckMs(600_000)
  idleNow()
  expect(await until(() => itemOf(a.id).state === 'offered', 1000)).toBe(true)
  await take(a.id)                                                          // b rides into a's turn at its Stop (the main's own pull)
  expect(['bound', 'done']).toContain(itemOf(b.id).state)
  await stop()
})

test('② the channel sentence stays for a record that says the main can take items and nothing went in (here: no stream to offer on)', () => {
  const src = readFileSync(join(import.meta.dir, 'lanes-main.ts'), 'utf8')
  expect(src).toContain("m === 'busy' || m === 'stuck' ? `主線的畫面顯示在處理中，但 ${Math.max(1, Math.round(MAIN_STUCK_MS / 60_000))} 分鐘沒有任何回合事件；有 ${owedNow.length} 件排著還沒交進去。`")
  expect(src).toContain('`主線收不到訊息：${owedNow.length} 則訊息送不進主線（它的訊息通道沒有開')
})

test('一 no status record here (Onsen step 3 off): M2 decides as before — an idle main is offered at once', async () => {
  noRecord = true
  try {
    expect(L.mainCanTake()).toBeNull()
    expect(L.__main().deliveryNow()).toBe('offer')
    const m = joey('沒有狀態紀錄')
    await L.routeEvent(m)
    expect(rowOf(m.id)).toMatchObject({ decided_by: 'old' })
    expect(await until(() => itemOf(m.id).state === 'offered', 500)).toBe(true)
    await take(m.id)
  } finally { noRecord = false }
})

test('三 a no_reply call: the route row carries the decision\'s urgency, and the Onsen wake row takes it (interrupt, not a silent derived again)', async () => {
  idleNow()
  const got: Array<{ row: any; ctx: any }> = []
  L.observeRoutes((row, ctx) => { got.push({ row, ctx }) })
  const ev = { id: 'mesh-177-1', source: 'mesh', from: 'chiron', text: '只是讓你知道', verified: true, no_reply: true, line: 'call', btcc_msg_id: '177001',
    meta: { user: 'chiron' }, notif: { method: 'notifications/claude/channel', params: { content: '只是讓你知道', meta: { user: 'chiron' } } } }
  await L.routeEvent(ev as any)
  L.observeRoutes(null)
  const g = got.find(x => x.row.event === ev.id)!
  expect(g.row).toMatchObject({ decided_by: 'new', wake_urgency: 'interrupt' })
  const w = wakeItem(g.row, { ...g.ctx, did: null }, { agent: AGENT, host: 'h', at: new Date().toISOString(), idem: 'k', memberState: 'idle' })
  expect(w.urgency).toBe('interrupt')
  // a row no decision made keeps the old description (the old router's mesh-no-reply: silent)
  const old = wakeItem({ ...g.row, decided_by: 'old', wake_urgency: undefined }, { ...g.ctx, did: null }, { agent: AGENT, host: 'h', at: new Date().toISOString(), idem: 'k2', memberState: 'idle' })
  expect(old.urgency).toBe('silent')
})

test('六 a lane run\'s open tool reaches runningLanes() and the observation: doing {kind: tool, tool: Bash} while the call is open, thinking after its result', async () => {
  idleNow()
  const ev = { id: 'mesh-177-sched', source: 'mesh', from: 'scheduler', verified: true, text: '[scheduled][disk-check][run:17701][P3][routine] disk-check', meta: {},
    notif: { method: 'notifications/claude/channel', params: { content: 'disk-check', meta: {} } } }
  await L.routeEvent(ev as any)
  expect(await until(() => L.runningLanes().some(l => l.tool?.name === 'Bash'), 4000)).toBe(true)
  const lane = L.runningLanes().find(l => l.tool)!
  const prog = (): StatusView => ({ state: 'idle', detail: { queued_joey: 0, lanes: L.runningLanes() }, last_activity_at: new Date().toISOString() })
  let obs = composeRecord(null, regions(IDLE), prog(), { session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', queue: L.mainQueueCounts() }).observation
  const s = obs.sessions.find(x => x.id === lane.id)!
  expect(s.doing).toEqual({ kind: 'tool', tool: 'Bash', since: lane.tool!.since })
  expect(checkObservation(obs)).toEqual([])
  expect(await until(() => L.runningLanes().some(l => l.id === lane.id && !l.tool), 3000)).toBe(true)
  obs = composeRecord(null, regions(IDLE), prog(), { session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', queue: L.mainQueueCounts() }).observation
  expect(obs.sessions.find(x => x.id === lane.id)!.doing).toMatchObject({ kind: 'thinking', tool: null })
  // WO-177 (Chiron 04:01Z item 2): thinking since the tool came back, not since the run began
  const back = L.runningLanes().find(l => l.id === lane.id)!
  expect(back.thinking_since).toBeTruthy()
  expect(Date.parse(back.thinking_since!)).toBeGreaterThan(Date.parse(lane.tool!.since))
  expect(obs.sessions.find(x => x.id === lane.id)!.doing!.since).toBe(back.thinking_since!)
  expect(checkObservation(obs)).toEqual([])
  expect(await until(() => !L.runningLanes().some(l => l.id === lane.id), 4000)).toBe(true)
})
