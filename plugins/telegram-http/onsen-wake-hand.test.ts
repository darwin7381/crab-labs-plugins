// WO-147 1.49.1 (Chiron 09:56Z): the hand-over decisions as wake rows. #28 handoff_main, #29 a decision card (now / can wait), #30 the deferred cards'
// batch, #31 a lane run's end. Each writes ONE event-keyed wake / no_wake line in the state journal; the wake tap makes one row of each (handItem), and
// never one of an M1 item's own wake lines. The router in this process (lanes.ts, role tg), a lane script the test releases, a stand-in mailbox (as BTCC
// answers through fleet-mail.ts) and a stand-in main (its hook events). Every test ends with: the rows = the state journal's event-keyed wake lines, each
// joined by (event id, ts), and the item-keyed lines sent nowhere.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import * as W from './onsen-wake.ts'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?onsen-wake-hand') as typeof import('./lanes.ts')

const ws = mkdtempSync(join(tmpdir(), 'onsen-wake-hand-ws-'))
const dir = join(ws, '.lanes'); mkdirSync(dir)
const tmp = mkdtempSync(join(tmpdir(), 'onsen-wake-hand-'))
mkdirSync(join(tmp, 'tr'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const bin = join(tmp, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
lid = os.environ.get('LANE_ID', 'x')
go = os.path.join('${tmp}', 'go-' + lid)
t0 = time.time()
while time.time() - t0 < 60 and not os.path.exists(go): time.sleep(0.02)
try: os.remove(go)
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
let nextId = 14700
const iso = (ms: number) => new Date(ms).toISOString()
L.__setMailTool(async b => {
  const a = b.args ?? {}
  if (b.name === 'decide_later') { const id = ++nextId; return { text: `放進主線的信箱了（#${id}）。`, isError: false, mail_id: id, deadline: iso(Date.now() + 3600_000) } }
  if (b.name === 'mailbox_card') return { text: `#${a.id} 附上決定卡了。`, isError: false, mail_id: Number(a.id), deadline: iso(Date.now() + 86_400_000) }
  if (b.name === 'mailbox_open') return { text: `#${a.id} 來自 eve：要不要改 timeout`, isError: false }
  if (b.name === 'mailbox_check') return { text: `#${a.id} 勾掉了。`, isError: false }
  return { text: '1 封未讀', isError: false }
})
L.__setMeshSend(async b => ({ text: `sent to ${b.to}`, msgId: 74700, delivered: true }))
const open = new Set<string>(), offers: any[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve'],
  notifySession: async (sid: string, notif: any) => { if (!open.has(sid)) return false; offers.push(notif); return true }, streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
const procs: any[] = []
afterAll(() => { for (const f of Object.keys(L.__lanesState().lanes)) try { writeFileSync(join(tmp, `go-${f}`), 'ok') } catch {}
  for (const p of procs) try { p.kill('SIGKILL') } catch {}
  L.observeWakes(null); L.__setClaudeBin(restore); L.__setMailTool(null); L.__setMeshSend(null)
  delete process.env.LANES_FLOOD_CONTROL
  rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }) })

const O = { agent: 'adam', host: 'mini', idem: 'wake:adam:1:b:1', memberState: 'idle' }
const rows: W.WakeItem[] = []
L.observeWakes((line, ctx) => { rows.push(W.handItem(line, ctx, O)) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const journal = (): any[] => readFileSync(join(dir, 'lanes', 'state.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
/** the state journal's event-keyed wake lines (an id with no M1 item record): the lines the tap must send, one row each */
const eventWakes = (): any[] => { const j = journal(), items = new Set(j.filter(l => l.rec === 'msg').map(l => l.id)); return j.filter(l => l.rec === 'wake' && !items.has(l.id)) }
const itemWakes = (): any[] => { const j = journal(), items = new Set(j.filter(l => l.rec === 'msg').map(l => l.id)); return j.filter(l => l.rec === 'wake' && items.has(l.id)) }
/** the rows equal the event-keyed lines, one for one: the same multiset of (id, ts, reason) (two lines of one event can share a millisecond) */
function joined(): void {
  const lines = eventWakes()
  expect(rows.length).toBe(lines.length)
  const key = (id: unknown, ts: unknown, reason: unknown) => `${id}|${ts}|${reason}`
  expect(rows.map(r => key(r.refs.event_id, r.at, r.note)).sort()).toEqual(lines.map(l => key(l.id, l.ts, l.reason)).sort())
  for (const l of itemWakes()) expect(rows.some(r => r.refs.event_id === l.id)).toBe(false)     // an item's own line: never a row
}
const M = () => L.__main(), E = () => L.__events()
let n = 0
const peer = (text: string) => ({ id: `mesh-hand-${++n}`, source: 'mesh', from: 'eve', verified: true, text, meta: {}, line: 'call',
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
const reminder = () => { const text = '讀信箱（1 封未讀，最舊的等了 10 分鐘）：先用 mailbox_list'
  return { id: `mesh-hand-${++n}`, source: 'mesh', from: 'fleet-watchdog', verified: true, text, meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail',
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }
type Run = { id: string; lane: string; tok: any }
async function start(ev: any): Promise<Run> {
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ target: 'lane' })
  expect(await until(() => !!L.__runTok(d.lane!) && L.__runTok(d.lane!)!.evId === ev.id)).toBe(true)
  return { id: ev.id, lane: d.lane!, tok: L.__runTok(d.lane!)! }
}
async function end(r: Run): Promise<void> {
  writeFileSync(join(tmp, `go-${r.lane}`), 'ok')
  expect(await until(() => L.__runTok(r.lane)?.evId !== r.id)).toBe(true)
  await sleep(40)
}
const call = (r: Run, name: string, a: object) => L.callLaneTool(r.tok, name, a)
const CARD = { decide: '要不要把 api-gw 的 timeout 改成 30 秒', recommend: '改（p99 已 24 秒）', basis: 'Grafana p99', then: '改設定、回 Eve' }
const RECEIPT = { outcome: 'done', happened: 'Eve 問', did: '交出去了', promised: '無', needs_main: '見交接' }
/** the main: a stand-in process whose stream is open (idle → offered) and whose turns the test drives */
const p = Bun.spawn(['sleep', '600']); procs.push(p)
const sid = randomUUID(); writeFileSync(join(dir, 'main-expected'), sid); open.add(`mcp-${p.pid}`); L.__noteMcpPid(`mcp-${p.pid}`, p.pid)
const hook = (event: string, o: object = {}) => L.__mainEvent({ event, pid: p.pid, session_id: sid, ...o } as any)
await hook('SessionStart', { source: 'startup' })
async function turn(): Promise<void> {
  const pr = `p-${randomUUID().slice(0, 6)}`
  await hook('UserPromptSubmit', { prompt_id: pr, dids: M().items(r => r.state === 'offered').map(r => r.id) })
  await hook('Stop', { prompt_id: pr, phase: 'final' })
}
const since = (k: number) => rows.slice(k)

test('#28 handoff_main: one row (handoff, ordered, main_now, its M1 item); the run that then ends owes nothing: exit-none (silent, none)', async () => {
  expect(M().mainPhase()).toBe('idle')
  const k = rows.length
  const r = await start(peer('能答應週五給報表嗎？'))
  await call(r, 'handoff_main', { text: 'Eve 要週五報表，要主線決定' })
  const h = since(k).filter(x => x.rule === 'handoff_main')
  expect(h).toHaveLength(1)
  const item = M().items(x => x.kind === 'handoff' && x.event === r.id)[0]!
  expect(h[0]).toMatchObject({ source_kind: 'handoff', urgency: 'ordered', target: 'main_now', sender: r.lane, refs: { event_id: r.id, did: item.id }, preview: '能答應週五給報表嗎？' })
  expect(h[0]!.note).toContain('owed to the main (ho-')
  await call(r, 'receipt', RECEIPT)
  await end(r)
  const x = since(k).filter(x => x.source_kind === 'lane_exit')
  expect(x.map(y => y.rule)).toEqual(['exit-none'])
  expect(x[0]).toMatchObject({ urgency: 'silent', target: 'none', refs: { event_id: r.id } })
  expect(x[0]!.refs.did).toBeUndefined()
  expect(x[0]!.note).toBe('the run ended; the event owes nothing more: recorded only')
  await turn()
  joined()
})

test('#31 a run that ends still owing (the peer\'s answer): exit-owes (lane_exit, ordered), the main by its state: main_after_step while it is in a turn', async () => {
  const k = rows.length
  const r = await start(peer('維護幾點？'))
  const pr = 'p-busy'
  await hook('UserPromptSubmit', { prompt_id: pr })                                  // the main is in a turn now
  expect(M().mainPhase()).toBe('in_turn')
  await end(r)                                                                         // no answer, no receipt: the run ends owing eve an answer
  const x = since(k).filter(y => y.source_kind === 'lane_exit')
  expect(x).toHaveLength(1)
  expect(x[0]).toMatchObject({ rule: 'exit-owes', urgency: 'ordered', target: 'main_after_step', sender: r.lane, refs: { event_id: r.id } })
  expect(x[0]!.refs.did).toBe(M().items(y => y.kind === 'handoff' && y.event === r.id)[0]!.id)
  await hook('Stop', { prompt_id: pr, phase: 'final' })
  await sleep(30); await turn()
  joined()
})

test('#29 a decision card: urgent_because → card-now (interrupt, an item); can wait → card-deferred (silent, none, no item); then handoff_main wakes it: handoff-woke-deferred (interrupt)', async () => {
  await sleep(30)
  expect(M().mainPhase()).toBe('idle')
  const k = rows.length
  const a = await start(peer('api-gw 的 timeout 今天要定'))
  const outA = await call(a, 'decide_later', { title: 'timeout', card: CARD, urgent_because: 'Eve 的部署卡在這一步，今天下班前要' })
  const mA = Number(outA.match(/#(\d+)/)![1])
  const now = since(k).filter(x => x.rule === 'card-now')
  expect(now).toHaveLength(1)
  expect(now[0]).toMatchObject({ source_kind: 'card', urgency: 'interrupt', target: 'main_now', refs: { event_id: a.id, mail_id: String(mA) } })
  expect(now[0]!.refs.did).toBe(M().items(x => x.event === a.id && x.kind === 'carry')[0]!.id)
  await call(a, 'receipt', RECEIPT); await end(a); await turn()
  const k2 = rows.length
  const b = await start(peer('下季的預算格式要不要改'))
  const outB = await call(b, 'decide_later', { title: '預算格式', card: CARD })
  const mB = Number(outB.match(/#(\d+)/)![1])
  const def = since(k2).filter(x => x.rule === 'card-deferred')
  expect(def).toHaveLength(1)
  expect(def[0]).toMatchObject({ source_kind: 'card', urgency: 'silent', target: 'none', refs: { event_id: b.id, mail_id: String(mB) } })
  expect(def[0]!.refs.did).toBeUndefined()
  expect(M().items(x => x.event === b.id)).toHaveLength(0)                               // can wait: no item, nobody woken
  await call(b, 'handoff_main', { text: '其實等不起：Eve 說明天就要用' })
  const wk = since(k2).filter(x => x.rule === 'handoff-woke-deferred')
  expect(wk).toHaveLength(1)
  expect(wk[0]).toMatchObject({ source_kind: 'handoff', urgency: 'interrupt', target: 'main_now', refs: { event_id: b.id } })
  expect(wk[0]!.refs.did).toBe(M().items(x => x.event === b.id && x.kind === 'handoff')[0]!.id)
  await call(b, 'receipt', RECEIPT); await end(b); await turn()
  joined()
})

test('#30 the deferred cards\' batch: one row (batch, ordered, main_now, its carry item) when the earliest untold card waited LANES_DEFER_MAX_WAIT_S', async () => {
  await sleep(30)
  const k = rows.length
  const r = await start(peer('辦公室的冷氣要不要換'))
  const out = await call(r, 'decide_later', { title: '冷氣', card: CARD })
  const m = Number(out.match(/#(\d+)/)![1])
  await call(r, 'receipt', RECEIPT); await end(r)
  E().note(r.id, { waits: E().get(r.id)!.waits.map((w: any) => w.mail_id === m ? { ...w, at: iso(Date.now() - 46 * 60_000) } : w) })   // placed 46 min ago
  L.dueTick()
  expect(await until(() => since(k).some(x => x.source_kind === 'batch'))).toBe(true)
  const b = since(k).filter(x => x.source_kind === 'batch')
  expect(b).toHaveLength(1)
  const batchId = String(b[0]!.refs.event_id)
  expect(batchId).toMatch(/^batch-/)
  expect(b[0]).toMatchObject({ rule: 'defer-batch', urgency: 'ordered', target: 'main_now', sender: 'lanes', refs: { did: M().items(x => x.event === batchId)[0]!.id } })
  expect(b[0]!.preview).toContain(`#${m}`)
  L.dueTick(); await sleep(30)
  expect(since(k).filter(x => x.source_kind === 'batch')).toHaveLength(1)                  // one batch at a time
  await turn()
  joined()
})

test('the mail lane: a card that cannot wait (mailbox_card) → card-now; then handoff_main adds to that hand-over: handoff-addToMain (interrupt); each one row', async () => {
  await sleep(30)
  const k = rows.length
  const r = await start(reminder())
  await call(r, 'mailbox_open', { id: 14801 })
  await call(r, 'mailbox_card', { id: 14801, card: CARD, urgent_because: 'Eve 的部署卡在這一步' })
  const c = since(k).filter(x => x.rule === 'card-now')
  expect(c).toHaveLength(1)
  expect(c[0]).toMatchObject({ source_kind: 'card', urgency: 'interrupt', refs: { event_id: r.id, mail_id: '14801' } })
  await call(r, 'handoff_main', { text: '這一趟自己出了狀況：另一封信打不開，整件交回' })
  const add = since(k).filter(x => x.rule === 'handoff-addToMain')
  expect(add).toHaveLength(1)
  expect(add[0]).toMatchObject({ source_kind: 'handoff', urgency: 'interrupt', refs: { event_id: r.id } })
  expect(add[0]!.refs.did).toBe(M().items(x => x.event === r.id && x.kind === 'handoff').at(-1)!.id)
  await call(r, 'receipt', { ...RECEIPT, happened: '讀信' }); await end(r); await turn()
  joined()
})

test('every event-keyed wake line is one row (by kind), every item-keyed one none; with no tap, asWake is the call itself', async () => {
  await sleep(50)
  joined()
  const byKind = (k: string) => rows.filter(r => r.source_kind === k).length
  expect(byKind('handoff')).toBeGreaterThanOrEqual(3); expect(byKind('card')).toBeGreaterThanOrEqual(3); expect(byKind('batch')).toBe(1); expect(byKind('lane_exit')).toBeGreaterThanOrEqual(2)
  expect(rows.every(r => W.HAND_RULES.includes(r.rule!))).toBe(true)
  expect(itemWakes().length).toBeGreaterThan(0)                                         // the items' own lines exist, and none became a row (joined)
  // no tap: the same decision writes the same line, nothing is shown
  L.observeWakes(null)
  const k = rows.length, before = eventWakes().length
  const r = await start(peer('沒有 tap 的這一趟'))
  await call(r, 'handoff_main', { text: '交給主線' })
  expect(eventWakes().length).toBe(before + 1)
  expect(rows.length).toBe(k)
  await call(r, 'receipt', RECEIPT); await end(r); await turn()
})
