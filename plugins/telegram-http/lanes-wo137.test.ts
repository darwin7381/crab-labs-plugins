// WO-137 甲 (telegram-http 1.41.1, Chiron's ticket): 「等得起」 means batched, not held until the deadline. 11-24 14:09Z → 18:21Z: of 9 cards that could wait,
// 4 were never told their main (atlas #11276 / #11278, cards 14:49:28Z / 14:49:30Z, deadline 11-25 12:00Z: the due wake would have come at 11:45Z, 21 h later;
// lynceus #11248; epeius #11307). A card the main has not been told about yet waits at most LANES_DEFER_MAX_WAIT_S (2700 s) from the agent's earliest such
// card: a digest that lists it reaching the main tells it (whatever woke the main); otherwise one batch wake (main_wake cause `batch`) carries every card
// waiting. Its deadline and its due wake stay; a batch wake is never pushed to Joey. The tests follow the ticket's acceptance list; time is moved by
// placing a card's `at` back (the batch clock is the card's own placing time) and by the due sweep's `now`.
// The mailbox is a stand-in that answers as BTCC does through fleet-mail.ts; the main is a stand-in process whose Telegram stream is open (an idle main is
// offered items: that offer is a wake) and whose turns the test drives through its hook events.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { dueEvent } from './mail-events.ts'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?wo137') as typeof import('./lanes.ts')
const B = await import('./lanes-boundary.ts')
const { mainContext } = await import('./lanes-main.ts')

const ws = mkdtempSync(join(tmpdir(), 'lanes-wo137-ws-'))
const dir = join(ws, '.lanes'); mkdirSync(dir)
const tmp = mkdtempSync(join(tmpdir(), 'lanes-wo137-'))
mkdirSync(join(tmp, 'tr'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const ARGV = join(tmp, 'argv.jsonl'), bin = join(tmp, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, time
lid = os.environ.get('LANE_ID', 'x')
with open('${ARGV}', 'a') as f: f.write(json.dumps({'lane': lid, 'argv': sys.argv[1:]}) + '\\n')
go = os.path.join('${tmp}', 'go-' + lid)
t0 = time.time()
while time.time() - t0 < 60 and not os.path.exists(go): time.sleep(0.02)
try: os.remove(go)
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
type Item = { id: number; lane: string; thread: string; ref: string | null; card: any; title: string; deadline: string }
const box = new Map<number, Item>()
let nextId = 13700, nextDeadline: string | null = null
const MIN = 60_000, H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()
const hourOut = (min = 60) => iso(Date.now() + min * MIN)
L.__setMailTool(async b => {
  const a = b.args ?? {}
  if (b.name === 'decide_later') {
    const id = ++nextId, deadline = nextDeadline ?? hourOut()
    box.set(id, { id, lane: b.lane, thread: a.thread, ref: a.ref ?? null, card: { ...a.card, deadline }, title: a.title, deadline })
    return { text: `放進主線的信箱了（#${id}）。`, isError: false, mail_id: id, deadline }
  }
  if (b.name === 'mailbox_card') {
    const id = Number(a.id), deadline = nextDeadline ?? hourOut(24 * 60)
    box.set(id, { id, lane: b.lane, thread: a.thread, ref: null, card: { ...a.card, deadline }, title: `來信 ${id}`, deadline })
    return { text: `#${id} 附上決定卡了。`, isError: false, mail_id: id, deadline }
  }
  if (b.name === 'mailbox_check') return { text: `#${a.id} 勾掉了。`, isError: false }
  if (b.name === 'mailbox_open') return { text: `#${a.id} 來自 board`, isError: false }
  return { text: '1 封未讀', isError: false }
})
L.__setMeshSend(async b => ({ text: `sent to ${b.to}`, msgId: 73700, delivered: true }))
const sent: Array<{ text: string; silent: boolean }> = []
const open = new Set<string>()
const offers: any[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve'],
  notifySession: async (sid: string, notif: any) => { if (!open.has(sid)) return false; offers.push(notif); return true }, streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 9800 + sent.length }, joeyChatId: () => '1' } as any)
const procs: any[] = []
afterAll(() => { for (const f of Object.keys(L.__lanesState().lanes)) try { writeFileSync(join(tmp, `go-${f}`), 'ok') } catch {}
  for (const p of procs) try { p.kill('SIGKILL') } catch {}
  L.__setClaudeBin(restore); L.__setMailTool(null); L.__setMeshSend(null)
  for (const k of ['LANES_FLOOD_CONTROL', 'LANES_DEFER_MAX_WAIT_S']) delete process.env[k]
  rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const jsonl = (p: string): any[] => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const laneRows = () => jsonl(join(dir, 'lanes.jsonl'))
const wakes = () => laneRows().filter(x => x.kind === 'main_wake')
const batches = () => laneRows().filter(x => x.kind === 'batch_wake')
const told = (m: number) => laneRows().filter(x => x.kind === 'card_told' && x.mail_id === m)
const runsOf = () => jsonl(ARGV)
const E = () => L.__events(), M = () => L.__main()
const contentOf = (n: any) => String(n?.params?.content ?? '')
const waitOf = (ev: string, m: number) => (E().get(ev)?.waits ?? []).find((w: any) => w.mail_id === m)
let n = 0
const peer = (text: string) => ({ id: `mesh-wo137-${++n}`, source: 'mesh', from: 'eve', verified: true, text, meta: {}, line: 'call',
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
const reminder = () => { const text = '讀信箱（2 封未讀，最舊的等了 10 分鐘）：先用 mailbox_list'
  return { id: `mesh-wo137-${++n}`, source: 'mesh', from: 'fleet-watchdog', verified: true, text, meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail',
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }
let tgN = 7300
const joey = (text: string) => { const id = String(++tgN), meta = { chat_id: '1', message_id: id, user: 'joey_lab' }
  return { id: `tg-1-${id}`, source: 'telegram', from: 'joey', text, meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any }
type Run = { id: string; lane: string; tok: any }
async function start(ev: any): Promise<Run> {
  const before = runsOf().length
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ target: 'lane' })
  expect(await until(() => !!L.__runTok(d.lane!) && L.__runTok(d.lane!)!.evId === ev.id && runsOf().length > before)).toBe(true)
  return { id: ev.id, lane: d.lane!, tok: L.__runTok(d.lane!)! }
}
async function end(r: Run): Promise<any> {
  writeFileSync(join(tmp, `go-${r.lane}`), 'ok')
  expect(await until(() => L.__runTok(r.lane)?.evId !== r.id)).toBe(true)
  await sleep(40)
  return laneRows().filter(x => x.kind === 'exit' && x.event === r.id).at(-1)
}
const call = (r: Run, name: string, a: object) => L.callLaneTool(r.tok, name, a)
const CARD = { decide: '要不要把 api-gw 的 timeout 改成 30 秒', recommend: '改（p99 已 24 秒）', basis: 'Grafana p99', then: '改設定、回 Eve' }
/** a reflex lane puts a card that can wait in the mailbox (decide_later) and ends: its event and mail id */
async function asked(text: string, extra: object = {}): Promise<{ id: string; m: number }> {
  const r = await start(peer(text))
  const out = await call(r, 'decide_later', { title: `${text.slice(0, 10)}：要不要改`, card: CARD, ...extra })
  const m = Number(out.match(/#(\d+)/)![1])
  await call(r, 'receipt', { outcome: 'done', happened: 'Eve 問', did: '放進主線信箱等決定', promised: '無', needs_main: `#${m}` })
  await end(r)
  return { id: r.id, m }
}
/** the card was placed `ago` ms before now (its `at`: the batch clock) */
function placedAgo(ev: string, m: number, ago: number): void {
  E().note(ev, { waits: E().get(ev)!.waits.map((w: any) => w.mail_id === m ? { ...w, at: iso(Date.now() - ago) } : w) })
}
type Main = { pid: number; sid: string; hook: (event: string, o?: object) => Promise<any>; kill: () => Promise<void> }
async function mainUp(): Promise<Main> {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const sid = randomUUID(); writeFileSync(join(dir, 'main-expected'), sid); open.add(`mcp-${p.pid}`); L.__noteMcpPid(`mcp-${p.pid}`, p.pid)
  const hook = (event: string, o: object = {}) => L.__mainEvent({ event, pid: p.pid, session_id: sid, ...o } as any)
  await hook('SessionStart', { source: 'startup' })
  return { pid: p.pid, sid, hook, kill: async () => { await hook('SessionEnd'); p.kill('SIGKILL') } }
}
/** the main's turn takes what was offered (and these events' items) and ends with Stop: the items are done, the main is idle again */
async function turn(m: Main, ...evs: string[]): Promise<void> {
  const p = `p-${randomUUID().slice(0, 6)}`
  await m.hook('UserPromptSubmit', { prompt_id: p, dids: M().items(r => r.state !== 'done' && (r.state === 'offered' || evs.includes(String(r.event)))).map(r => r.id) })
  await m.hook('Stop', { prompt_id: p, phase: 'final' })
}
/** nothing a test leaves behind waits on the next one's main */
function settle(...ids: string[]): void {
  for (const id of ids) { if (!E().get(id)) continue; E().set(id, o => o.kind === 'main' && o.state === 'open', { state: 'met', by: 'test' }); E().set(id, o => ['joey', 'peer', 'receipt'].includes(o.kind) && (o.state === 'handed' || o.state === 'open'), { state: 'met', by: 'test' }) }
  for (const e of E().rows(r => ids.includes(r.id))) if (Array.isArray(e.waits)) E().note(e.id, { waits: e.waits.map((w: any) => w.decided || w.checked ? w : { ...w, checked: { by: 'test', at: iso(Date.now()) } }) })
  for (const e of E().rows(r => !!r.batch && r.state === 'open')) E().set(e.id, o => o.kind === 'main' && o.state === 'open', { state: 'met', by: 'test' })
}
const BATCH_HEAD = '〔信箱｜等你決定的事｜一批｜batch-'

// ------------------------------------------------------------------ the words (item 7)
test('WO-137 甲 item 7: the main\'s rule, verbatim, right after the decision card\'s; LANES_DEFER_MAX_WAIT_S=0: 1.41.0\'s words', () => {
  const ctx = mainContext('adam', 'sid').split('\n')
  expect(ctx[ctx.indexOf(B.decisionMainRule()) + 1]).toBe('- 等得起的事會併成一批告訴你：你每次醒來，摘要會列「信箱有幾件等你決定」；你一直沒醒的話，最晚 45 分鐘會為它們叫你一次。快到期的那一件會再單獨叫你。')
  expect(ctx.join('\n')).not.toContain(B.DEFER_MAIN_RULE)
  process.env.LANES_DEFER_MAX_WAIT_S = '0'
  try { const c0 = mainContext('adam', 'sid').split('\n'); expect(c0[c0.indexOf(B.decisionMainRule()) + 1]).toBe(B.DEFER_MAIN_RULE) } finally { delete process.env.LANES_DEFER_MAX_WAIT_S }
})

// ------------------------------------------------------------------ 1: one card, the mail's deadline the next day: the batch wake at 45 minutes, then the due wake
test('WO-137 甲 #1: an idle main, one card that can wait whose deadline is the next day: no wake at 44:59; one batch wake at 45:00 (the digest lists it, cause batch, told_s 2700); the main takes it, no push after 300 s; no second batch; then the due wake', async () => {
  const m0 = await mainUp()
  const k = sent.length, w0 = wakes().length, o0 = offers.length, b0 = batches().length
  nextDeadline = hourOut(24 * 60)
  const { id, m } = await asked('api-gw 的 timeout 明天前要定')
  nextDeadline = null
  expect(offers.length).toBe(o0); expect(wakes().length).toBe(w0)                                      // can wait: nobody woken when it is placed
  placedAgo(id, m, 45 * MIN - 1000); L.dueTick(); await sleep(50)
  expect(batches().length).toBe(b0); expect(offers.length).toBe(o0)                                    // 44:59: not yet
  placedAgo(id, m, 45 * MIN + 1000); L.dueTick()
  expect(await until(() => offers.length > o0 && wakes().length > w0)).toBe(true)
  expect(batches().slice(b0)).toMatchObject([{ cards: [m], main_phase: 'idle' }])
  expect(batches().at(-1).waited_s).toBeGreaterThanOrEqual(2700); expect(batches().at(-1).waited_s).toBeLessThan(2705)
  expect(wakes().slice(w0)).toMatchObject([{ cause: 'batch', item_kind: 'carry' }])
  const c = contentOf(offers.at(-1))
  expect(c).toContain('〔信箱有 1 件等你決定'); expect(c).toContain(`• #${m}「`); expect(c).toContain(`｜期限 `)
  expect(c).toContain(BATCH_HEAD); expect(c).toContain('1 件放進來之後還沒讓你看過'); expect(c).toContain('mailbox_decide(id, decision=')
  const w = waitOf(id, m)
  expect(w).toMatchObject({ told_via: 'batch', deadline: box.get(m)!.deadline })                      // item 3: the card's deadline as it was
  expect(w.told_s).toBeGreaterThanOrEqual(2700); expect(w.told_s).toBeLessThan(2710)                   // item 6: card placed → main first told
  expect(told(m)).toMatchObject([{ via: 'batch', event: id, urgency: 'defer' }])
  const bid = batches().at(-1).batch
  expect(E().get(bid)!.obligations.find((o: any) => o.kind === 'main')).toMatchObject({ state: 'open', woke: 'batch' })
  expect(E().get(bid)!.obligations.find((o: any) => o.kind === 'main').due_at).toBeUndefined()          // item 4: no due time
  await turn(m0, bid)
  expect(E().get(bid)!.obligations.find((o: any) => o.kind === 'main')).toMatchObject({ state: 'met' })
  L.dueTick(Date.now() + 301_000); L.dueTick(Date.now() + 3 * H); await sleep(50)
  expect(sent.slice(k)).toEqual([])                                                                    // nothing pushed to Joey
  expect(batches().length).toBe(b0 + 1)                                                                // told: no second batch
  expect(E().get(id)!.obligations.find((o: any) => o.kind === 'main')).toMatchObject({ state: 'open', defer: true })   // the card's own hand-over still waits
  // the due wake (deadline − 15 min), as before
  const due = box.get(m)!
  await L.routeEvent(dueEvent({ id: m, title: due.title, decide: due.card.decide, recommend: due.card.recommend, deadline: due.deadline, lane: due.lane, thread: due.thread, ref: due.ref }) as any)
  expect(await until(() => wakes().length > w0 + 1)).toBe(true)
  expect(wakes().slice(w0).map(x => x.cause)).toEqual(['batch', 'due'])
  expect(contentOf(offers.at(-1))).toContain(`〔要你決定｜快到期｜`)
  settle(id); await turn(m0, id); await m0.kill()
}, 40000)

// ------------------------------------------------------------------ 2: three cards within 30 minutes: one batch wake carrying 3
test('WO-137 甲 #2: three cards placed within 30 minutes, the main idle: one batch wake 45 minutes after the first, carrying all three; each told by it; no second batch', async () => {
  const m0 = await mainUp()
  const w0 = wakes().length, o0 = offers.length, b0 = batches().length
  nextDeadline = hourOut(24 * 60)
  const a = await asked('第一件：api-gw timeout'), b = await asked('第二件：cdn 快取'), c = await asked('第三件：備份保留天數')
  nextDeadline = null
  placedAgo(a.id, a.m, 30 * MIN); placedAgo(b.id, b.m, 20 * MIN); placedAgo(c.id, c.m, 2 * MIN)
  L.dueTick(); await sleep(50)
  expect(batches().length).toBe(b0); expect(offers.length).toBe(o0)
  placedAgo(a.id, a.m, 45 * MIN + 1000); placedAgo(b.id, b.m, 30 * MIN); placedAgo(c.id, c.m, 15 * MIN)
  L.dueTick()
  expect(await until(() => offers.length > o0 && wakes().length > w0)).toBe(true)
  expect(batches().slice(b0)).toMatchObject([{ cards: [a.m, b.m, c.m] }])
  const t = contentOf(offers.at(-1))
  expect(t).toContain('〔信箱有 3 件等你決定'); for (const x of [a, b, c]) expect(t).toContain(`• #${x.m}「`)
  expect(t).toContain('3 件放進來之後還沒讓你看過')
  expect(wakes().slice(w0)).toMatchObject([{ cause: 'batch' }])
  for (const x of [a, b, c]) expect(waitOf(x.id, x.m)).toMatchObject({ told_via: 'batch' })
  expect(waitOf(c.id, c.m).told_s).toBeGreaterThanOrEqual(900); expect(waitOf(c.id, c.m).told_s).toBeLessThan(910)
  await turn(m0, batches().at(-1).batch)
  L.dueTick(Date.now() + 2 * H); await sleep(50)
  expect(batches().length).toBe(b0 + 1); expect(wakes().length).toBe(w0 + 1)
  settle(a.id, b.id, c.id); await m0.kill()
}, 40000)

// ------------------------------------------------------------------ 3: the main woke for something else and saw the card: no batch wake
test('WO-137 甲 #3: the main woke for something else (Joey) within 45 minutes; the digest riding that wake listed the card: told (via other); 46 minutes after it was placed, no batch wake', async () => {
  const m0 = await mainUp()
  const w0 = wakes().length, o0 = offers.length, b0 = batches().length
  nextDeadline = hourOut(24 * 60)
  const { id, m } = await asked('要不要延長 staging 的憑證')
  nextDeadline = null
  placedAgo(id, m, 20 * MIN)
  const j = joey('主線在嗎？看一下今天的部署')
  expect(await L.routeEvent(j)).toMatchObject({ target: 'main' })
  expect(await until(() => offers.length > o0 && wakes().length > w0)).toBe(true)
  expect(contentOf(offers.at(-1))).toContain(`• #${m}「`)                                            // the digest of that wake lists it
  expect(waitOf(id, m)).toMatchObject({ told_via: 'other' })
  expect(waitOf(id, m).told_s).toBeGreaterThanOrEqual(1200); expect(waitOf(id, m).told_s).toBeLessThan(1210)
  expect(told(m)).toMatchObject([{ via: 'other' }])
  await turn(m0, j.id)
  L.mainReplied(L.mainReplyTier({}), 9890)
  placedAgo(id, m, 46 * MIN); L.dueTick(); L.dueTick(Date.now() + 3 * H); await sleep(50)
  expect(batches().length).toBe(b0)
  expect(wakes().slice(w0).map(x => x.cause)).toEqual(['other'])
  // item 2: told by a delivery that is not a wake (pulled into a running turn) counts the same
  const x = await asked('要不要換 log 保留期')
  const p = `p-${randomUUID().slice(0, 6)}`
  await m0.hook('UserPromptSubmit', { prompt_id: p })                                               // the main is in a turn of its own
  const j2 = joey('順便：把今天的部署清單貼給我')
  expect(await L.routeEvent(j2)).toMatchObject({ target: 'main' })
  await m0.hook('PreToolUse', { prompt_id: p, tool_name: 'Bash', tool_input: { command: 'ls' } })
  await m0.hook('PostToolUse', { prompt_id: p, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok', tool_error: false })   // a boundary: it pulls
  expect(await until(() => !!waitOf(x.id, x.m)?.told_at)).toBe(true)
  await m0.hook('Stop', { prompt_id: p, phase: 'final' })
  placedAgo(x.id, x.m, 46 * MIN); L.dueTick(); await sleep(50)
  expect(batches().length).toBe(b0)
  settle(id, x.id, j2.id); await m0.kill()
}, 40000)

// ------------------------------------------------------------------ 4: a batch wake nobody handles is never pushed to Joey
test('WO-137 甲 #4: a batch wake the main does not take (offered and left; or no main at all): nothing is pushed to Joey after 300 s or an hour; one batch, not a second', async () => {
  const k = sent.length, b0 = batches().length, w0 = wakes().length
  nextDeadline = hourOut(24 * 60)
  const { id, m } = await asked('要不要清 staging 的舊映像')                                         // no main registered
  nextDeadline = null
  placedAgo(id, m, 46 * MIN); L.dueTick(); await sleep(50)
  expect(batches().slice(b0)).toMatchObject([{ cards: [m], main_phase: 'gone' }])
  const bid = batches().at(-1).batch
  const it = M().items(r => String(r.event) === bid)
  expect(it.map(r => r.state)).toEqual(['queued'])
  for (const dt of [301_000, 600_000, H, 5 * H]) L.dueTick(Date.now() + dt)
  await sleep(50)
  expect(sent.slice(k)).toEqual([]); expect(batches().length).toBe(b0 + 1)
  // the main comes up idle: the batch is offered once; it does not take it, and still nothing is pushed
  const o0 = offers.length
  const m0 = await mainUp()
  expect(await until(() => offers.length > o0 && wakes().length > w0)).toBe(true)
  expect(contentOf(offers.at(-1))).toContain(BATCH_HEAD)
  for (const dt of [301_000, H]) L.dueTick(Date.now() + dt)
  await sleep(50)
  expect(sent.slice(k)).toEqual([]); expect(batches().length).toBe(b0 + 1)
  settle(id); await turn(m0); await m0.kill()
}, 40000)

// ------------------------------------------------------------------ 5: urgent and critical cards are woken at once and never batched
test('WO-137 甲 #5: a card with urgent_because wakes the main at once (urgent_handoff) and does not start a batch clock; a batch wake still queued whose cards were told meanwhile is not offered', async () => {
  const m0 = await mainUp()
  const w0 = wakes().length, o0 = offers.length, b0 = batches().length
  const u = await asked('api-gw 5xx 一直高，現在能重啟嗎？', { urgent_because: 'Eve 的客戶正在等，5xx 12%' })
  expect(await until(() => wakes().length > w0)).toBe(true)
  expect(wakes().slice(w0)).toMatchObject([{ cause: 'urgent_handoff', event: u.id }])
  expect(waitOf(u.id, u.m)).toMatchObject({ urgency: 'urgent', told_via: 'urgent_handoff' })
  await turn(m0, u.id)
  placedAgo(u.id, u.m, 2 * H); L.dueTick(); await sleep(50)
  expect(batches().length).toBe(b0)
  settle(u.id)
  // the main is gone; Joey's message waits for it; then a batch is made (newer). Back, the main is offered Joey's message first: the digest riding it lists the
  // card (told: other), and the batch, still queued, is met without being offered
  await m0.kill()
  nextDeadline = hourOut(24 * 60)
  const d = await asked('要不要關掉舊的 webhook')
  nextDeadline = null
  const j = joey('早安，今天有什麼事？')
  expect(await L.routeEvent(j)).toMatchObject({ target: 'main' })
  placedAgo(d.id, d.m, 46 * MIN); L.dueTick(); await sleep(50)
  expect(batches().length).toBe(b0 + 1)
  const bid = batches().at(-1).batch
  const it = M().items(r => String(r.event) === bid)[0]
  expect(it.state).toBe('queued')
  const o1 = offers.length
  const m1 = await mainUp()
  expect(await until(() => offers.length > o1 && wakes().length > w0 + 1)).toBe(true)
  const first = contentOf(offers[o1])
  expect(first).toContain('早安，今天有什麼事？'); expect(first).toContain(`• #${d.m}「`); expect(first).not.toContain(BATCH_HEAD)
  expect(waitOf(d.id, d.m)).toMatchObject({ told_via: 'other' })
  expect(E().get(bid)!.obligations.find((o: any) => o.kind === 'main')).toMatchObject({ state: 'met' })
  await turn(m1, j.id); await sleep(100)
  expect(offers.slice(o1).filter(x => contentOf(x).includes(BATCH_HEAD))).toEqual([])                 // never offered
  expect(M().items(r => r.id === it.id)[0].state).toBe('queued')
  expect(wakes().slice(w0).map(x => x.cause)).toEqual(['urgent_handoff', 'other'])
  expect(o0).toBeLessThan(offers.length)
  settle(d.id, j.id); await m1.kill()
}, 40000)

// ------------------------------------------------------------------ 6: replay of atlas #11276 / #11278
test('WO-137 甲 #6, replay of atlas 11-24: two board cards placed 14:49:28.584Z and 14:49:30.876Z (deadline 11-25 12:00Z, can wait), the main idle: not at 15:34:28.583Z; one batch wake at 15:34:28.584Z carrying both (1.41.0: none before 11:45Z)', async () => {
  const m0 = await mainUp()
  const w0 = wakes().length, o0 = offers.length, b0 = batches().length
  nextDeadline = '2026-11-25T12:00:00.000Z'
  const w = await start(reminder())
  for (const id of [11276, 11278]) {
    await call(w, 'mailbox_open', { id })
    expect(await call(w, 'mailbox_card', { id, card: { decide: `驗收 WO-${id === 11276 ? 135 : 136}`, recommend: '沒有建議', then: '無，主線自己做' } })).toContain('It can wait')
  }
  nextDeadline = null
  await call(w, 'receipt', { outcome: 'done', happened: '信箱 2 封 board 驗收通知', did: '各附決定卡', promised: '無', needs_main: '#11276、#11278' })
  await end(w)
  E().note(w.id, { waits: E().get(w.id)!.waits.map((x: any) => ({ ...x, at: x.mail_id === 11276 ? '2026-11-24T14:49:28.584Z' : '2026-11-24T14:49:30.876Z' })) })
  L.dueTick(Date.parse('2026-11-24T15:34:28.583Z')); await sleep(50)
  expect(batches().length).toBe(b0); expect(offers.length).toBe(o0)
  L.dueTick(Date.parse('2026-11-24T15:34:28.584Z'))
  expect(await until(() => offers.length > o0 && wakes().length > w0)).toBe(true)
  expect(batches().slice(b0)).toMatchObject([{ cards: [11276, 11278], first_at: '2026-11-24T14:49:28.584Z', waited_s: 2700 }])
  expect(wakes().slice(w0)).toMatchObject([{ cause: 'batch' }])
  const c = contentOf(offers.at(-1))
  expect(c).toContain('〔信箱有 2 件等你決定'); expect(c).toContain('• #11276｜要你決定：驗收 WO-135｜期限 11-25 20:00'); expect(c).toContain('• #11278｜要你決定：驗收 WO-136｜期限 11-25 20:00'); 
  for (const id of [11276, 11278]) expect(waitOf(w.id, id)).toMatchObject({ told_via: 'batch', deadline: '2026-11-25T12:00:00.000Z' })
  settle(w.id); await turn(m0); await m0.kill()
}, 40000)

// ------------------------------------------------------------------ 7: a daemon restart keeps the clock
test('WO-137 甲 #7: the clock survives a daemon restart (it is the cards\' own placing time and the batch records, in the state journal): a daemon booted on a journal with a card placed 30 minutes ago makes no batch now, one at 45:00; a daemon booted on a journal with an open batch makes no second one', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'lanes-wo137-boot-'))
  copyFileSync(process.env.LANES_TEST_ROUTER!, join(d2, 'router.json'))
  mkdirSync(join(d2, 'lanes'), { recursive: true })
  const at = iso(Date.now() - 30 * MIN), ts = iso(Date.now() - 30 * MIN)
  const card = { mail_id: 13990, item: 'lane_item', title: '要不要改 timeout', decide: '改不改', deadline: iso(Date.now() + 20 * H), at, lane: 'adam.reflex.1', thread: 'adam#t-boot',
    cls: 'peer', trigger: 'peer', card: { decide: '改不改', recommend: '改' }, urgency: 'defer' }
  const obligations = [{ id: 'joey-b1', kind: 'joey', level: 'line', state: 'handed', by: 'adam.reflex.1' },
    { id: 'ho-boot1', kind: 'main', level: 'handed', state: 'open', by: 'adam.reflex.1', owner: 'main', handoff: 'ho-boot1', at, defer: true, card: true }]
  writeFileSync(join(d2, 'lanes', 'state.jsonl'), JSON.stringify({ ts, rec: 'event', id: 'mesh-boot-1', state: 'open', obligations, class: 'peer', owner: 'adam.reflex.1', outcome: 'normal',
    thread: 'adam#t-boot', lane: 'adam.reflex.1', from: 'eve', text: 'api-gw timeout？', waits: [card] }) + '\n')
  process.env.LANES_DIR = d2
  const R = await import('./lanes.ts?wo137-boot') as typeof import('./lanes.ts')
  R.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: d2, transcriptDir: d2, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => [] } as any)
  process.env.LANES_DIR = dir
  const rows = () => jsonl(join(d2, 'lanes.jsonl')).filter(x => x.kind === 'batch_wake')
  R.dueTick(); await sleep(50)
  expect(rows()).toEqual([])
  R.dueTick(Date.parse(at) + 45 * MIN + 1)
  expect(rows()).toMatchObject([{ cards: [13990], first_at: at, main_phase: 'gone' }])
  const bid = rows()[0].batch
  expect(R.__events().get(bid)!.batch).toMatchObject({ cards: [13990], first_at: at })
  // a second boot on that journal: the batch is open (not reached the main yet): none more
  process.env.LANES_DIR = d2
  const R2 = await import('./lanes.ts?wo137-boot2') as typeof import('./lanes.ts')
  R2.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: d2, transcriptDir: d2, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => [] } as any)
  process.env.LANES_DIR = dir
  R2.dueTick(Date.parse(at) + 2 * H); await sleep(50)
  expect(rows().length).toBe(1)
  expect(R2.__events().get(bid)!.obligations.find((o: any) => o.kind === 'main')).toMatchObject({ state: 'open', woke: 'batch' })
  Bun.spawnSync(['pkill', '-f', d2])
}, 30000)

// ------------------------------------------------------------------ 8: the switch
test('WO-137 甲 #8: LANES_DEFER_MAX_WAIT_S=0 = 1.41.0: no batch wake however long a card waits; the digest has no `cards`; no card_told row; the main\'s rule is 1.41.0\'s', async () => {
  process.env.LANES_DEFER_MAX_WAIT_S = '0'
  try {
    const m0 = await mainUp()
    const w0 = wakes().length, o0 = offers.length, b0 = batches().length, t0 = laneRows().filter(x => x.kind === 'card_told').length
    nextDeadline = hourOut(24 * 60)
    const { id, m } = await asked('要不要停用舊的 API key')
    nextDeadline = null
    placedAgo(id, m, 5 * H); L.dueTick(); L.dueTick(Date.now() + 10 * H); await sleep(50)
    expect(batches().length).toBe(b0); expect(offers.length).toBe(o0); expect(wakes().length).toBe(w0)
    const j = joey('主線在嗎？')
    await L.routeEvent(j)
    expect(await until(() => offers.length > o0 && wakes().length > w0)).toBe(true)
    expect(contentOf(offers.at(-1))).toContain(`• #${m}「`)                                          // 1.41.0: every delivery lists what waits
    expect((M().items(r => r.kind === 'digest' && r.state !== 'queued').at(-1)!.cards ?? []).includes(m)).toBe(false)   // not written with the switch off
    expect(waitOf(id, m).told_at).toBeUndefined()
    expect(laneRows().filter(x => x.kind === 'card_told').length).toBe(t0)
    expect(mainContext('adam', 'sid')).toContain(B.DEFER_MAIN_RULE)
    settle(id, j.id); await turn(m0, j.id); await m0.kill()
  } finally { delete process.env.LANES_DEFER_MAX_WAIT_S }
}, 40000)
