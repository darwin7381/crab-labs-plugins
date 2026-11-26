// WO-128 final (telegram-http 1.41.0): Chiron's note on the ticket, 2026-11-24 13:00Z (「照這一則做完就可以上線」). The tests are named after its points:
//   二  the mail lane's line 3 (verbatim) and its mechanism: a card without urgent_because wakes nobody and the lane stop asks for no handoff_main; with it,
//       the system wakes the main at once with the card (no handoff_main needed); handoff_main stays for 「這一趟自己出了狀況、要整件交回」
//   三  the due wake follows the card's deadline: the card's own, else the mail's, else (a mail with none, e.g. a board notice 「期限 —」) an hour from when it
//       is attached. The agent-inbox daemon fills it before the card goes to BTCC (fleet-mail.ts), and reads /due?within=900 every 60 s (mail-events.ts,
//       server.ts), so an hour's card is woken once, at about 45 minutes (Chiron wrote about 55; the window is Epeius's and is not changed here)
//   四  a card of a run that handles a critical alert (its own, or one merged into it by WO-132's incident merge) cannot wait, decided by the system whatever
//       urgent_because says; replay of kot.reflex.3 (alert 1356 critical); runs that follow 「正式服務正在壞」 hand over with handoff_main and wake the main
//   四、其他 the boundary card: WO-128's line in place of 「沒把握：…」, WO-132's production line after it
// and the switch: LANES_DEFER_DECISIONS=0 = 1.40.0. The mailbox is a stand-in that answers as BTCC's routers/mail.py does (6bd7fc2: a card's fallback deadline
// is the mail's, else mail_deadline_h; /due lists undecided cards within the window); the mail lane's mailbox_card goes through the real fleet-mail.ts as the
// agent-inbox daemon's mailTool sends it (server.ts). The main is a stand-in process whose Telegram stream is open (an idle main is offered items: a wake).
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { MailEvents, WITHIN_S } from './mail-events.ts'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?wo128final') as typeof import('./lanes.ts')
const B = await import('./lanes-boundary.ts')
const { callInboxTool } = await import('./fleet-mail.ts')

const ws = mkdtempSync(join(tmpdir(), 'lanes-wo128f-ws-'))
const dir = join(ws, '.lanes'); mkdirSync(dir)
const tmp = mkdtempSync(join(tmpdir(), 'lanes-wo128f-'))
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

// ------------------------------------------------------------------ the mailbox (BTCC routers/mail.py, as far as these calls go)
type Mail = { id: number; from: string; title: string; deadline: string | null; no_reply: boolean; card?: any; card_lane?: string; card_thread?: string | null; lane_item?: boolean }
const mails = new Map<number, Mail>()
const btccSeen: Array<{ method: string; path: string; body?: any }> = []
let btccGetFails = false, nextLaneItem = 12900
const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()
async function btcc(method: 'GET' | 'POST', path: string, body?: any): Promise<{ status: number; json: any }> {
  btccSeen.push({ method, path, body })
  let m = path.match(/^\/api\/mesh\/mail\/(\d+)\?by=lane(?:&lane=[^&]+)?$/)   // WO-173: a lane's read may name the lane
  if (method === 'GET' && m) {
    if (btccGetFails) return { status: 503, json: { detail: 'down' } }
    const x = mails.get(Number(m[1]))
    return x ? { status: 200, json: { id: x.id, from: x.from, title: x.title, deadline: x.deadline, no_reply: x.no_reply, status: 'lane_read' } } : { status: 404, json: { detail: 'no mail' } }
  }
  m = path.match(/^\/api\/mesh\/mail\/(\d+)\/card\?by=lane$/)
  if (method === 'POST' && m) {
    const x = mails.get(Number(m[1]))
    if (!x) return { status: 404, json: { detail: 'no mail' } }
    if (x.card) return { status: 409, json: { detail: 'one card per mail' } }
    // attach_card: fallback = r["deadline"] or now + mail_deadline_h (24 h); the card's own deadline wins
    const deadline = body.card?.deadline ? iso(Date.parse(body.card.deadline)) : x.deadline ?? iso(Date.now() + 24 * H)
    x.card = { ...body.card, deadline }; x.card_lane = body.lane; x.card_thread = body.thread ?? null
    return { status: 200, json: { id: x.id, status: 'lane_read', card_at: iso(Date.now()), deadline, no_reply: x.no_reply } }
  }
  if (method === 'POST' && path === '/api/mesh/mail/lane-item?by=lane') {
    const id = ++nextLaneItem, deadline = body.deadline ? iso(Date.parse(body.deadline)) : body.card?.deadline ? iso(Date.parse(body.card.deadline)) : iso(Date.now() + H)
    mails.set(id, { id, from: 'adam', title: body.title, deadline, no_reply: true, card: { ...body.card, deadline }, card_lane: body.lane, card_thread: body.thread ?? null, lane_item: true })
    return { status: 200, json: { id, deadline, ref: body.ref ?? null, status: 'lane_read', no_reply: true } }
  }
  if (method === 'POST' && /^\/api\/mesh\/mail\/\d+\/check$/.test(path)) return { status: 200, json: { status: 'checked' } }
  return { status: 200, json: {} }
}
/** GET /due?within=<s> at `now`: undecided cards whose deadline is within the window or past, soonest first */
const dueAt = (now: number, within = WITHIN_S) => [...mails.values()].filter(x => x.card && Date.parse(x.card.deadline) <= now + within * 1000)
  .sort((a, b) => Date.parse(a.card.deadline) - Date.parse(b.card.deadline))
  .map(x => ({ id: x.id, from: x.from, title: x.title, deadline: x.card.deadline, decide: x.card.decide, recommend: x.card.recommend, lane: x.card_lane, thread: x.card_thread,
    overdue: Date.parse(x.card.deadline) < now }))
const mailCalls: any[] = []
// the agent-inbox daemon's mailTool for decide_later / mailbox_card (server.ts): the real fleet-mail.ts tool with the lane's id, BTCC's answer's id and deadline
L.__setMailTool(async b => {
  mailCalls.push(b)
  if (b.name === 'decide_later' || b.name === 'mailbox_card') {
    let got: any = null
    const res: any = await callInboxTool(b.name, b.args, { call: async () => '', core: async () => ({ status: 200, json: {} }), openBy: 'lane', lane: b.lane,
      btcc: async (m, p, body) => { const r = await btcc(m, p, body); if (m === 'POST' && /^\/api\/mesh\/mail\/(lane-item|\d+\/card)/.test(p)) got = r; return r } }, false)
    const j = got?.status === 200 ? got.json : null
    return { text: String(res?.content?.[0]?.text ?? ''), isError: !!res?.isError, ...(j ? { mail_id: j.id, deadline: j.deadline, no_reply: j.no_reply } : {}) }
  }
  if (b.name === 'mailbox_check') return { text: `#${b.args.id} 勾掉了。`, isError: false }
  if (b.name === 'mailbox_open') return { text: `#${b.args.id} 來自 ${mails.get(Number(b.args.id))?.from ?? 'eve'}`, isError: false }
  return { text: '1 封未讀', isError: false }
})
L.__setMeshSend(async b => ({ text: `sent to ${b.to}`, msgId: 73000, delivered: true }))
const sent: Array<{ text: string; silent: boolean }> = []
const open = new Set<string>()
const offers: any[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve'],
  notifySession: async (sid: string, notif: any) => { if (!open.has(sid)) return false; offers.push(notif); return true }, streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 9700 + sent.length }, joeyChatId: () => '1' } as any)
const procs: any[] = []
afterAll(() => { for (const f of Object.keys(L.__lanesState().lanes)) try { writeFileSync(join(tmp, `go-${f}`), 'ok') } catch {}
  for (const p of procs) try { p.kill('SIGKILL') } catch {}
  L.__setClaudeBin(restore); L.__setMailTool(null); L.__setMeshSend(null)
  for (const k of ['LANES_FLOOD_CONTROL', 'LANES_DEFER_DECISIONS']) delete process.env[k]
  rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const jsonl = (p: string): any[] => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const laneRows = () => jsonl(join(dir, 'lanes.jsonl'))
const ledger = () => jsonl(join(dir, 'ledger.jsonl'))
const wakes = () => laneRows().filter(x => x.kind === 'main_wake')
const runsOf = () => jsonl(ARGV)
const E = () => L.__events(), M = () => L.__main()
const mainOb = (id: string) => (E().get(id)?.obligations ?? []).filter((o: any) => o.kind === 'main').at(-1)
const itemsOf = (ev: string) => M().items(r => String(r.event) === ev && r.kind !== 'digest')
const contentOf = (n: any) => String(n?.params?.content ?? '')
let n = 0
const reminder = () => { const text = '讀信箱（1 封未讀，最舊的等了 10 分鐘）：先用 mailbox_list'
  return { id: `mesh-wo128f-${++n}`, source: 'mesh', from: 'fleet-watchdog', verified: true, text, meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail',
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }
const ALERT_META = { chat_id: 'local-inject', user: 'alert-dispatcher', user_id: 'local-inject', via: 'local-inject', verified: 'true', relay: 'oncall-receiver', line: 'call' }
const alert = (id: string, text: string) => ({ id, source: 'mesh', from: 'alert-dispatcher', verified: true, text, line: 'call', meta: { ...ALERT_META },
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
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
type Main = { pid: number; sid: string; hook: (event: string, o?: object) => Promise<any>; kill: () => Promise<void> }
async function mainUp(): Promise<Main> {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const sid = randomUUID(); writeFileSync(join(dir, 'main-expected'), sid); open.add(`mcp-${p.pid}`); L.__noteMcpPid(`mcp-${p.pid}`, p.pid)
  const hook = (event: string, o: object = {}) => L.__mainEvent({ event, pid: p.pid, session_id: sid, ...o } as any)
  await hook('SessionStart', { source: 'startup' })
  return { pid: p.pid, sid, hook, kill: async () => { await hook('SessionEnd'); p.kill('SIGKILL') } }
}
/** nothing a test leaves behind is owed to the next one's main */
function settle(...ids: string[]): void {
  for (const id of ids) { if (!E().get(id)) continue; E().set(id, o => o.kind === 'main' && o.state === 'open', { state: 'met', by: 'test' }); E().set(id, o => ['joey', 'peer', 'receipt'].includes(o.kind) && (o.state === 'handed' || o.state === 'open'), { state: 'met', by: 'test' }) }
  for (const e of E().rows(r => ids.includes(r.id))) if (Array.isArray(e.waits)) E().note(e.id, { waits: e.waits.map((w: any) => w.decided || w.checked ? w : { ...w, checked: { by: 'test', at: new Date().toISOString() } }) })
}
/** the main's turn takes these events' items and ends (Stop final: the items are done, the main is idle and offered what comes next) */
async function takes(m: Main, ...evs: string[]): Promise<void> {
  const p = `p-${randomUUID().slice(0, 6)}`
  await m.hook('UserPromptSubmit', { prompt_id: p, dids: M().items(r => r.state !== 'done' && evs.includes(String(r.event))).map(r => r.id) })
  await m.hook('Stop', { prompt_id: p, phase: 'final' })
}
/** the test is over: what it left is met, its items are taken, the main goes */
async function finish(m: Main, ...ids: string[]): Promise<void> { settle(...ids); await takes(m, ...ids); await m.kill() }
const board = (id: number, title = '[board][WO-140] 待你驗收：auth 頁改版') => mails.set(id, { id, from: 'board', title, deadline: null, no_reply: true })   // a program's mail: no deadline
const peerMail = (id: number, deadline: string | null, title = 'Eve：週五交規格可以嗎') => mails.set(id, { id, from: 'eve', title, deadline, no_reply: false })

// Chiron's line 3, as he wrote it on the ticket (13:00Z), ${D.agent} = adam
const LINE_3 = '- 要主線的信（要代表 adam 答應或決定、要做不可逆的事、要主線手上的脈絡或工具、只有主線能做的事例如工單驗收）：在那封信上附卡（mailbox_card），五格：要 adam 決定或做什麼／期限（信有寫就照信；沒寫就照這件事填一個）／信裡的關鍵事實與出處（數字、檔案位置、它給的選項）／你的建議和根據（查不到根據就寫「沒有建議」）／主線說好之後你會做什麼（整件只能主線自己做的就寫「無，主線自己做」）。那一封不要勾掉。等得起（預設）：附完就好，不叫醒主線；它下次醒來會在摘要看到，快到期才會被單獨叫。等不起（晚了會壞，或有人正在等）：附卡時在 urgent_because 寫什麼會壞、誰在等，主線會馬上被叫醒。主線用 mailbox_decide 回了決定，你會被叫起來照決定做完。焦點卡上寫「交回主線」的類別，意思是由主線決定，不是不讓你讀：照樣打開、照樣整理。'
// 1.38.3's (Chiron #11046): the switch-off line
const LINE_3_OFF = '- 要主線的信（要代表 adam 答應或決定、要做不可逆的事、要主線手上的脈絡或工具）：在那封信上附決定卡（mailbox_card），五格：要 adam 決定什麼／期限／信裡的關鍵事實與出處（數字、檔案位置、它給的選項）／你的建議和根據（查不到根據就寫「沒有建議」）／主線說好之後你會做什麼。附完用 handoff_main 交回，一句話列出附了卡的 #id 和各要決定什麼，卡的內容不用再寫一次。那一封不要勾掉。主線用 mailbox_decide 回了決定，你會被叫起來照決定做完。整件只能主線自己做的（收不回的動作、要它這段對話才知道的事、工單驗收）：不附卡，用 handoff_main 把 #id、寄件人、期限、它要什麼、關鍵事實寫清楚交回。焦點卡上寫「交回主線」的類別，意思是由主線決定，不是不讓你讀：照樣打開、照樣整理。'

// ------------------------------------------------------------------ 二 (the words), 四、其他 (the boundary card)
test('WO-128 final 二: the mail lane\'s line 3 is Chiron\'s 13:00Z line, verbatim, in place of #11046\'s (one line 3); 四、其他: the boundary card has WO-128\'s line in place of 「沒把握：…」 and WO-132\'s production line right after it', () => {
  const card = L.identityCard({ kind: 'mail' }).split('\n')
  expect(card).toContain(LINE_3)
  expect(card.filter(l => l.startsWith('- 要主線的信')).length).toBe(1)
  expect(card).not.toContain(LINE_3_OFF)
  const b = B.boundaryDefault('adam')
  const i = b.indexOf(B.BOUNDARY_DEFER_LINE)
  expect(b[i]).toBe('要主線決定的那一步：等得起就用 decide_later 放進主線的信箱，不叫醒它；等不起才叫醒，寫出什麼會壞、誰在等。沒把握：當它等得起，不叫醒，也不猜著做完。')
  expect(b[i + 1]).toBe(B.boundaryProdLine('adam'))                                                   // 1.41.1 (WO-137 乙): the production line's words
  expect(b.join('\n')).not.toContain('沒把握：交給主線，不猜著做完。')
})

// ------------------------------------------------------------------ 二: a mail-lane card without urgent_because, and with it
test('WO-128 final 二: a mail-lane card without urgent_because: no wake, the lane stop asks for no handoff_main, no push; with urgent_because: the system wakes the main at once with the card (urgent_handoff), no handoff_main needed', async () => {
  const m0 = await mainUp()
  const k = sent.length, w0 = wakes().length, o0 = offers.length
  peerMail(8901, iso(Date.now() + 5 * H)); peerMail(8902, iso(Date.now() + 2 * H), 'Lynx：今晚停機可以嗎')
  const w = await start(reminder())
  await call(w, 'mailbox_open', { id: 8901 })
  expect(await call(w, 'mailbox_card', { id: 8901, card: { decide: '答不答應 Eve 週五交規格', recommend: '答應', then: '回 Eve 好' } })).toContain('It can wait')
  expect(L.laneStop(w.tok)).toBeNull()                                                                  // no handoff_main asked for
  await call(w, 'receipt', { outcome: 'done', happened: '1 封', did: '附卡', promised: '無', needs_main: '#8901' })
  expect(await end(w)).toMatchObject({ card_urgency: 'defer' })
  expect(itemsOf(w.id)).toEqual([]); expect(offers.length).toBe(o0); expect(wakes().length).toBe(w0); expect(sent.slice(k)).toEqual([])
  expect(mainOb(w.id)).toMatchObject({ state: 'open', defer: true, card: true }); expect(mainOb(w.id).woke).toBeUndefined()
  // with urgent_because
  const w2 = await start(reminder())
  await call(w2, 'mailbox_open', { id: 8902 })
  const out = await call(w2, 'mailbox_card', { id: 8902, card: { decide: '今晚 02:00 停機照不照排', recommend: '照排', basis: '流量最低' }, urgent_because: 'Lynx 在等，今晚 01:00 前要排' })
  expect(out).toContain('It cannot wait: the main is woken now with this card'); expect(out).toContain('Do not hand this card over with handoff_main')
  expect(await until(() => offers.length > o0)).toBe(true)                                              // at once: the idle main is offered it
  expect(wakes().slice(w0)).toMatchObject([{ cause: 'urgent_handoff', event: w2.id, item_kind: 'carry' }])
  const c = contentOf(offers.at(-1))
  expect(c).toContain(`〔要你決定｜${mainOb(w2.id).handoff}｜信箱 #8902〕`); expect(c).toContain(`等不起（${w2.lane} 寫的）：Lynx 在等，今晚 01:00 前要排`)
  expect(c).toContain('要你決定：今晚 02:00 停機照不照排'); expect(c).toContain('mailbox_decide(id=8902')
  expect(mainOb(w2.id)).toMatchObject({ state: 'open', card: true, woke: 'urgent' }); expect(mainOb(w2.id).defer).toBeUndefined()
  expect(L.laneStop(w2.tok)).toBeNull()                                                                 // handed by the system: nothing asked
  expect(mailCalls.filter(x => x.name === 'mailbox_card').every(x => x.args.urgent_because === undefined)).toBe(true)   // not sent to BTCC
  await call(w2, 'receipt', { outcome: 'done', happened: '1 封', did: '附卡（等不起）', promised: '無', needs_main: '#8902' })
  expect(await end(w2)).toMatchObject({ card_urgency: 'urgent' })
  expect(ledger().find(x => x.event === w2.id && x.refs?.mailbox_card === 8902).text).toContain('；等不起：Lynx 在等')
  expect(sent.slice(k)).toEqual([])                                                                     // Joey: nothing when the card is attached
  await finish(m0, w.id, w2.id)
}, 40000)

// ------------------------------------------------------------------ 三: the card's deadline, and the one due wake
test('WO-128 final 三: a board notice (no deadline) with a can-wait card, the main never woken otherwise: the card gets an hour from when it is attached; the inbox daemon\'s /due?within=900 every 60 s hands over one mail_due at about 45 minutes; the main is woken once (cause due)', async () => {
  const m0 = await mainUp()
  const w0 = wakes().length, o0 = offers.length
  board(8911)
  const w = await start(reminder())
  await call(w, 'mailbox_open', { id: 8911 })
  const t0 = Date.now()
  expect(await call(w, 'mailbox_card', { id: 8911, card: { decide: '驗收 WO-140（auth 頁改版）', recommend: '驗收', then: '無，主線自己做' } })).toContain('It can wait')
  const t1 = Date.now()
  // the lanes asked for the default; the agent-inbox daemon read the mail (by=lane), found no deadline and gave the card an hour before BTCC saw it
  expect(mailCalls.at(-1).args.default_deadline_h).toBe(L.CARD_DEFAULT_DEADLINE_H)
  const seen = btccSeen.filter(x => x.path.startsWith('/api/mesh/mail/8911'))
  expect(seen.map(x => `${x.method} ${x.path}`)).toEqual([`GET /api/mesh/mail/8911?by=lane&lane=${encodeURIComponent(w.lane)}`, 'POST /api/mesh/mail/8911/card?by=lane'])
  const dl = Date.parse(seen[1].body.card.deadline)
  expect(dl).toBeGreaterThanOrEqual(t0 + H); expect(dl).toBeLessThanOrEqual(t1 + H)
  expect(Object.keys(seen[1].body.card).sort()).toEqual(['deadline', 'decide', 'recommend', 'then'])   // BTCC's boxes only (default_deadline_h is not one)
  expect(E().get(w.id)!.waits.at(-1)).toMatchObject({ mail_id: 8911, urgency: 'defer', deadline: iso(dl) })
  await call(w, 'receipt', { outcome: 'done', happened: '1 封（工單通知）', did: '附卡', promised: '無', needs_main: '#8911' })
  await end(w)
  // the agent-inbox daemon's due reader (mail-events.ts; server.ts ticks it every 60 s, the first 15 s after start), on a clock from the card's attach
  const fired: number[] = []
  const clock = { now: t1 }
  const me = new MailEvents({ file: join(tmp, 'mail-events.json'), log: () => {}, now: () => clock.now,
    send: async ev => { fired.push(clock.now - t1); return !!(await L.routeEvent(ev as any)) } })
  for (let s = 15; s <= 60 * 60; s += 60) {
    clock.now = t1 + s * 1000
    await me.tick(async () => dueAt(clock.now))
  }
  expect(await until(() => wakes().length > w0)).toBe(true)
  expect(fired.length).toBe(1)                                                                         // exactly one mail_due
  expect(fired[0]).toBeGreaterThanOrEqual((60 - 15) * 60_000 - 1000); expect(fired[0]).toBeLessThan(46 * 60_000)   // deadline − 15 min: about 45 minutes in
  expect(wakes().slice(w0)).toMatchObject([{ cause: 'due', event: w.id }])                             // the one wake of the main
  expect(wakes().slice(w0).length).toBe(1)
  expect(contentOf(offers.at(-1))).toContain(`〔要你決定｜快到期｜${mainOb(w.id).handoff}｜信箱 #8911〕`)
  expect(offers.length).toBe(o0 + 1)
  await finish(m0, w.id)
}, 60000)

test('WO-128 final 三: the card\'s deadline: its own if given (no read); else the mail\'s (BTCC falls back to it); a mail without one: an hour; the mail unreadable: an hour; without default_deadline_h (the switch off, or an older tg daemon) as before', async () => {
  const deps = (lane = 'adam.mail.1') => ({ call: async () => '', core: async () => ({ status: 200, json: {} }), openBy: 'lane' as const, lane, btcc })
  const posted = (id: number) => btccSeen.filter(x => x.method === 'POST' && x.path === `/api/mesh/mail/${id}/card?by=lane`).at(-1)!.body.card
  const gets = (id: number) => btccSeen.filter(x => x.method === 'GET' && x.path.startsWith(`/api/mesh/mail/${id}?by=lane`)).length
  const own = iso(Date.now() + 3 * H)
  board(8921); await callInboxTool('mailbox_card', { id: 8921, card: { decide: 'd', recommend: 'r', deadline: own }, default_deadline_h: 1 }, deps(), false)
  expect(posted(8921).deadline).toBe(own); expect(gets(8921)).toBe(0)                                     // its own
  const mailDl = iso(Date.now() + 26 * H)
  peerMail(8922, mailDl); await callInboxTool('mailbox_card', { id: 8922, card: { decide: 'd', recommend: 'r' }, default_deadline_h: 1 }, deps(), false)
  expect(posted(8922).deadline).toBeUndefined(); expect(gets(8922)).toBe(1); expect(mails.get(8922)!.card.deadline).toBe(mailDl)   // the mail's
  board(8923); const t = Date.now(); await callInboxTool('mailbox_card', { id: 8923, card: { decide: 'd', recommend: 'r' }, default_deadline_h: 1 }, deps(), false)
  expect(Math.abs(Date.parse(posted(8923).deadline) - (t + H))).toBeLessThan(2000)                       // none: an hour
  btccGetFails = true
  try { peerMail(8924, mailDl); const t2 = Date.now(); await callInboxTool('mailbox_card', { id: 8924, card: { decide: 'd', recommend: 'r' }, default_deadline_h: 1 }, deps(), false)
    expect(Math.abs(Date.parse(posted(8924).deadline) - (t2 + H))).toBeLessThan(2000) } finally { btccGetFails = false }   // unreadable: an hour (an early wake, never none)
  board(8925); await callInboxTool('mailbox_card', { id: 8925, card: { decide: 'd', recommend: 'r' } }, deps(), false)
  expect(posted(8925).deadline).toBeUndefined(); expect(gets(8925)).toBe(0)
  expect(Date.parse(mails.get(8925)!.card.deadline) - Date.now()).toBeGreaterThan(23 * H)                // BTCC's own fallback, 24 h (1.40.0)
})

// ------------------------------------------------------------------ 四: a critical alert's run
const KOT_1356 = '【警報 critical】alert 1356：kot-bstocks / kot-tokyo-1 / bstocks_live.stopped_FUSE = FUSE\n真單程式自己停了：保險絲（累計虧到觸發線），部位已清（剩的不到最小名目）。已實現 -5.42215、手續費 0.349521、含未平 -5.771671、量 20348.22、部位 空手（狀態檔 2026-11-24 02:30:00.236）。現在要報 Joey；FUSE 之後不刪狀態檔、不重開，等他說。\n接收人：kot（建立者 kot；alert）。\n接手就把這張 ack（by=你）。'
const KOT_CARD = { decide: 'bStocks 真單保險絲觸發後要不要重開', facts: '已實現 −5.42、費 0.35、含未平 −5.77（觸發線 −5.50）；部位空手；子帳權益 −4.56，帳戶保險絲 −5.5', recommend: '不重開，等 Joey', basis: 'FUSE 之後不刪狀態檔、不重開，等他說（警報原文）', then: '照決定回報 Joey；不重開' }
test('WO-128 final 四, replay of kot.reflex.3 (alert 1356 critical): a card from that run wakes the main at once without urgent_because (the system\'s 等不起 line; urgent_by critical in the record and the ledger)', async () => {
  const m0 = await mainUp()
  const w0 = wakes().length, o0 = offers.length
  const r = await start(alert('mesh-1795487426117-55ba', KOT_1356))
  expect(E().get(r.id)!.class).toBe('critical')
  const out = await call(r, 'decide_later', { title: 'bStocks 保險絲觸發：要不要重開', card: KOT_CARD })      // no urgent_because (the default 「沒把握當等得起」)
  expect(out).toContain('The main was woken with your card (this run handles a critical alert')
  expect(await until(() => offers.length > o0)).toBe(true)
  expect(wakes().slice(w0)).toMatchObject([{ cause: 'urgent_handoff', event: r.id, item_kind: 'carry' }])
  const c = contentOf(offers.at(-1))
  expect(c).toContain(`等不起（系統判定：${L.CRITICAL_URGENT_WHY}）`); expect(c).toContain('要你決定：bStocks 真單保險絲觸發後要不要重開')
  expect(mainOb(r.id)).toMatchObject({ state: 'open', card: true, woke: 'urgent' }); expect(mainOb(r.id).defer).toBeUndefined()
  const w = E().get(r.id)!.waits.at(-1)
  expect(w).toMatchObject({ urgency: 'urgent', urgent_by: 'critical' }); expect(w.urgent_because).toBeUndefined()
  const row = ledger().find(x => x.event === r.id && x.kind === 'action' && x.refs?.decide_later)
  expect(row.refs).toMatchObject({ urgency: 'urgent', urgent_by: 'critical' }); expect(row.text).toContain(`；等不起（系統判定：${L.CRITICAL_URGENT_WHY}）`)
  await call(r, 'receipt', { outcome: 'changed', happened: 'alert 1356：保險絲觸發', did: '唯讀查、開卡', promised: '無', needs_main: '要不要重開' })
  expect(await end(r)).toMatchObject({ card_urgency: 'urgent' })
  // the lane wrote a reason too: both are on the item
  const r2 = await start(alert('mesh-wo128f-kot-2', KOT_1356.replace('alert 1356', 'alert 1356b').replace('kot-tokyo-1', 'kot-tokyo-2')))
  await call(r2, 'decide_later', { title: '要不要重開（二）', card: KOT_CARD, urgent_because: 'Joey 在等' })
  expect(await until(() => itemsOf(r2.id).length === 1)).toBe(true)
  expect(contentOf(itemsOf(r2.id)[0].notif)).toContain(`等不起（系統判定：${L.CRITICAL_URGENT_WHY}）；${r2.lane} 寫的：Joey 在等`)
  await call(r2, 'receipt', { outcome: 'changed', happened: 'x', did: 'x', promised: '無', needs_main: 'x' }); await end(r2)
  await finish(m0, r.id, r2.id)
}, 40000)

test('WO-128 final 四: a critical alert merged into a warning run (WO-132 incident merge): its cards cannot wait, whether the merge raised the run (its line still owed) or the alert is still on its way to the run (the line went); a warning run alone: the card can wait', async () => {
  const m0 = await mainUp()
  // a warning run alone: can wait
  const a = await start(alert('mesh-wo128f-w0', '【警報 warning】alert 2200：netdata / lab-box-9 / disk_space./ = 90%\nroot 使用 90%'))
  expect(await call(a, 'decide_later', { title: '要不要清 lab-box-9 的 log', card: { decide: '清不清', recommend: '清' } })).toContain('It can wait')
  await call(a, 'receipt', { outcome: 'done', happened: 'x', did: 'x', promised: '無', needs_main: 'x' }); expect(await end(a)).toMatchObject({ card_urgency: 'defer' })
  // merged while the run's line is still owed: the run is raised (its event critical)
  const r = await start(alert('mesh-wo128f-w1', '【警報 warning】alert 2201：netdata / lab-alpha / mem.available = 9%\n可用記憶體 9%'))
  expect(await L.routeEvent(alert('mesh-wo128f-c1', '【警報 critical】alert 2202：netdata / lab-alpha / load.cpu = 99%\nCPU 99% 十分鐘'))).toMatchObject({ rule: 'incident-merge', lane: r.lane })
  expect(E().get(r.id)!.class).toBe('critical')
  const o0 = offers.length
  expect(await call(r, 'decide_later', { title: '要不要重開 lab-alpha 的 worker', card: { decide: '重開嗎', recommend: '重開' } })).toContain('The main was woken with your card (this run handles a critical alert')
  expect(await until(() => offers.length > o0)).toBe(true)
  await call(r, 'receipt', { outcome: 'changed', happened: 'x', did: 'x', promised: '無', needs_main: 'x' }); expect(await end(r)).toMatchObject({ card_urgency: 'urgent' })
  // merged after the run's line went: the critical alert is its own event, handed to the run in progress (not reached yet): still the run's incident
  const r2 = await start(alert('mesh-wo128f-w2', '【警報 warning】alert 2203：netdata / lab-beta / inode./ = 92%'))
  expect(await call(r2, 'notify_joey', { outcome: 'normal', text: 'lab-beta inode 92%，查證中。' })).toContain('sent to Joey')
  await L.routeEvent(alert('mesh-wo128f-c2', '【警報 critical】alert 2204：netdata / lab-beta / load.cpu = 99%'))
  expect(E().get(r2.id)!.class).toBe('alert'); expect(E().get('mesh-wo128f-c2')!.class).toBe('critical')
  expect(L.__runEvents(r2.lane)).not.toContain('mesh-wo128f-c2')                                       // not reached by the run yet
  expect(await call(r2, 'decide_later', { title: '要不要擴 lab-beta 的磁碟', card: { decide: '擴嗎', recommend: '擴' } })).toContain('this run handles a critical alert')
  expect(E().get(r2.id)!.waits.at(-1)).toMatchObject({ urgency: 'urgent', urgent_by: 'critical' })
  await call(r2, 'receipt', { outcome: 'changed', happened: 'x', did: 'x', promised: '無', needs_main: 'x' }); await end(r2)
  await finish(m0, a.id, r.id, r2.id, 'mesh-wo128f-c1', 'mesh-wo128f-c2')
}, 40000)

test('WO-128 final 四: runs that follow 「正式服務正在壞」 hand over with handoff_main (WO-132) and the main is woken at once, also when the run first put a card that can wait in the mailbox', async () => {
  const m0 = await mainUp()
  const w0 = wakes().length, o0 = offers.length
  const r = await start(alert('mesh-wo128f-p1', '【警報 warning】alert 2301：netdata / bt-xboard-falkenstein / httpcheck_kbro_auth_login.request_status = 1 checks\nEvery HTTP check to https://auth.kbro.ai/authui/login timed out'))
  expect(await call(r, 'handoff_main', { text: 'auth.kbro.ai 登入頁打不開（正式服務），讀者登不進來。指令備好：ssh xboard docker compose restart zitadel（我沒下）。' })).toContain('handed to the main')
  expect(await until(() => offers.length > o0)).toBe(true)
  expect(wakes().slice(w0)).toMatchObject([{ cause: 'urgent_handoff', event: r.id, item_kind: 'handoff' }])
  expect(contentOf(offers.at(-1))).toContain('auth.kbro.ai 登入頁打不開（正式服務）')
  await call(r, 'receipt', { outcome: 'changed', happened: 'x', did: '唯讀查、交主線', promised: '無', needs_main: '重啟' }); await end(r)
  settle(r.id); await takes(m0, r.id)
  // a card that can wait first (nobody woken), then the run finds production broken: handoff_main wakes the matter now
  const r2 = await start(alert('mesh-wo128f-p2', '【警報 warning】alert 2302：netdata / bt-app-1 / web_log.5xx = 12%'))
  expect(await call(r2, 'decide_later', { title: '要不要調高 bt-app-1 的 timeout', card: { decide: '調嗎', recommend: '調' } })).toContain('It can wait')
  expect(itemsOf(r2.id)).toEqual([])
  const o1 = offers.length, w1 = wakes().length
  expect(await call(r2, 'handoff_main', { text: 'bt-app-1 正式服務 5xx 12%，讀者打不開文章。指令備好：systemctl restart php-fpm（我沒下）。' })).toContain('it is woken now')
  expect(await until(() => offers.length > o1)).toBe(true)
  expect(wakes().slice(w1)).toMatchObject([{ cause: 'urgent_handoff', event: r2.id }])
  await call(r2, 'receipt', { outcome: 'changed', happened: 'x', did: 'x', promised: '無', needs_main: 'x' }); await end(r2)
  await finish(m0, r.id, r2.id)
}, 40000)

// ------------------------------------------------------------------ the switch
test('WO-128 final, LANES_DEFER_DECISIONS=0 = 1.40.0: #11046\'s line 3; a mail card asks for handoff_main and the lane stop asks once; no default deadline asked (BTCC\'s 24 h); a critical run\'s card is not marked urgent_by (every card wakes the main, as 1.38)', async () => {
  process.env.LANES_DEFER_DECISIONS = '0'
  try {
    const card = L.identityCard({ kind: 'mail' }).split('\n')
    expect(card).toContain(LINE_3_OFF); expect(card).not.toContain(LINE_3)
    expect(B.boundaryDefault('adam')).toContain('沒把握：交給主線，不猜著做完。')
    const m0 = await mainUp()
    board(8931)
    const w = await start(reminder())
    await call(w, 'mailbox_open', { id: 8931 })
    expect(await call(w, 'mailbox_card', { id: 8931, card: { decide: '驗收 WO-141', recommend: '驗收' }, urgent_because: '寄件人在等' })).toContain('Hand it to the main with handoff_main')
    expect(mailCalls.at(-1).args).toEqual({ id: 8931, card: { decide: '驗收 WO-141', recommend: '驗收' }, thread: L.__lanesState().lanes[w.lane].thread })
    expect(btccSeen.filter(x => x.method === 'GET' && x.path.startsWith('/api/mesh/mail/8931?by=lane')).length).toBe(0)
    expect(Date.parse(mails.get(8931)!.card.deadline) - Date.now()).toBeGreaterThan(23 * H)
    expect(String(L.laneStop(w.tok))).toContain('put decision cards on #8931 but has not handed them to the main')
    expect(itemsOf(w.id)).toEqual([])
    expect(await call(w, 'handoff_main', { text: '#8931 工單驗收' })).toContain('handed to the main')
    expect(E().get(w.id)!.waits.at(-1).urgency).toBeUndefined()
    await call(w, 'receipt', { outcome: 'done', happened: 'x', did: 'x', promised: '無', needs_main: 'x' })
    expect((await end(w)).card_urgency).toBeUndefined()
    const r = await start(alert('mesh-wo128f-off-c', KOT_1356.replace('alert 1356', 'alert 1356c').replace('kot-tokyo-1', 'kot-tokyo-3')))
    expect(await call(r, 'decide_later', { title: '要不要重開（開關關著）', card: KOT_CARD })).toContain('The main was woken with your card (hand-over')
    const wt = E().get(r.id)!.waits.at(-1)
    expect(wt.urgency).toBeUndefined(); expect(wt.urgent_by).toBeUndefined()
    expect(ledger().find(x => x.event === r.id && x.refs?.decide_later).refs.urgent_by).toBeUndefined()
    await call(r, 'receipt', { outcome: 'changed', happened: 'x', did: 'x', promised: '無', needs_main: 'x' }); await end(r)
    await finish(m0, w.id, r.id)
  } finally { delete process.env.LANES_DEFER_DECISIONS }
}, 40000)
