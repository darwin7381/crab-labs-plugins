// WO-127 (telegram-http 1.38.0): one round trip. The main answers one decision; the lane that asked finishes the work (Chiron's ticket; Joey 「那就試試看吧、
// 記得同步紀錄觀察點」, TG chiron:2095; seam claude-epeius/knowledge/lane-mailbox-seam.md v2). A lane puts a card in the main's mailbox (decide_later: the
// matter is handed to the main as handoff_main hands it), or the mail lane cards a colleague's mail (mailbox_card) and hands it over as today; the main
// answers with mailbox_decide; the agent-inbox daemon hands the router mail_decision; the router runs the lane of that thread, which finishes, tells Joey once
// (「照主線的決定（…）：」 in front) and cannot ask again. mail_due rides the main's next digest. LANES_DECISIONS=0: 1.37.2.
// The tests are named after the ticket's acceptance list (怎樣算完成 1-12). The mailbox (BTCC, fleet-mail.ts) is a stand-in that answers as BTCC does
// (an id per lane item, the card's deadline, the decision's lane / thread / ref); mail-events.ts builds the events the agent-inbox daemon hands the router.
// The main is a stand-in process whose turns the test drives through the main's hook events (M1 / M2), as lanes-m3-obligations does.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
import { decisionEvent, dueEvent } from './mail-events.ts'
process.env.LANES_FLOOD_CONTROL = '0'
// the tg daemon's own HTTP routes, for the agent-inbox side's calls into it (/lanes/mail-checked)
let Lref: any = null
const tgSrv = createServer(async (req, res) => { if (!Lref || !(await Lref.handleLanesHttp(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res))) res.writeHead(404).end() })
await new Promise<void>(r => tgSrv.listen(0, '127.0.0.1', () => r()))
process.env.LANES_TG_PORT = String((tgSrv.address() as any).port)
const L = await import('./lanes.ts?wo127') as typeof import('./lanes.ts')
delete process.env.LANES_TG_PORT
Lref = L
const B = await import('./lanes-boundary.ts')
const { mainContext } = await import('./lanes-main.ts')
const { LANE_DECIDE_LATER_TOOL, MAILBOX_CARD_TOOL } = await import('./fleet-mail.ts')

const ws = mkdtempSync(join(tmpdir(), 'lanes-wo127-ws-'))
const dir = join(ws, '.lanes'); mkdirSync(dir)
const tmp = mkdtempSync(join(tmpdir(), 'lanes-wo127-'))
mkdirSync(join(tmp, 'tr'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const ARGV = join(tmp, 'argv.jsonl'), bin = join(tmp, 'lane.py')
// the lane process: records its argv, ends when the test writes go-<lane id>
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
// the mailbox, as BTCC answers through fleet-mail.ts (decide_later → a lane item with an id; mailbox_card on a mail; mailbox_check)
type Item = { id: number; lane: string; thread: string; ref: string | null; card: any; title: string; deadline: string; from?: string }
const box = new Map<number, Item>()
const mailCalls: any[] = []
let nextId = 12700
L.__setMailTool(async b => {
  mailCalls.push(b)
  const a = b.args ?? {}
  if (b.name === 'decide_later') {
    if (!a.card?.decide || !a.card?.recommend) return { text: '沒有放進信箱：card: decide is required', isError: true }
    if ([...box.values()].some(x => x.ref && x.ref === a.ref)) return { text: `沒有放進信箱：ref ${a.ref} already opened`, isError: true }
    const id = ++nextId, deadline = '2026-11-24T13:00:00.000Z'
    box.set(id, { id, lane: b.lane, thread: a.thread, ref: a.ref ?? null, card: { ...a.card, deadline }, title: a.title, deadline })
    return { text: `放進主線的信箱了（#${id}，期限 11-24 13:00Z）。主線回決定後，這件會交回 ${a.thread} 接著做。`, isError: false, mail_id: id, deadline }
  }
  if (b.name === 'mailbox_card') {
    const id = Number(a.id), deadline = '2026-11-25T01:00:00.000Z'
    box.set(id, { id, lane: b.lane, thread: a.thread, ref: null, card: { ...a.card, deadline }, title: `來信 ${id}`, deadline, from: 'eve' })
    return { text: `#${id} 附上決定卡了（決定期限 11-25 01:00Z）。主線的清單會列出它；主線回決定後交回這條線做完。`, isError: false, mail_id: id, deadline }
  }
  if (b.name === 'mailbox_check') return { text: `#${a.id} 勾掉了，不在清單上了。`, isError: false }
  if (b.name === 'mailbox_reply') return { text: '回信放進對方信箱了（#9901，不用回）。', isError: false, to: 'eve' }
  if (b.name === 'mailbox_open') return { text: `#${a.id} 來自 eve｜要你決定\n\n內容 ${a.id}`, isError: false }
  return { text: '3 封未讀', isError: false }
})
const meshOut: any[] = []
L.__setMeshSend(async b => { meshOut.push(b); return { text: `sent to ${b.to}`, msgId: 71000 + meshOut.length, delivered: true } })
const sent: Array<{ text: string; silent: boolean }> = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve'],
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 9500 + sent.length }, joeyChatId: () => '1' } as any)
const procs: any[] = []
afterAll(() => { for (const f of [...Object.keys(L.__lanesState().lanes)]) try { writeFileSync(join(tmp, `go-${f}`), 'ok') } catch {}
  for (const p of procs) try { p.kill('SIGKILL') } catch {}
  tgSrv.close(); L.__setClaudeBin(restore); L.__setMailTool(null); L.__setMeshSend(null)
  for (const k of ['LANES_FLOOD_CONTROL', 'LANES_DECISIONS', 'LANES_DECISION_REPORTER']) delete process.env[k]
  rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const jsonl = (p: string): any[] => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const ledger = () => jsonl(join(dir, 'ledger.jsonl'))
const exits = () => jsonl(join(dir, 'lanes.jsonl')).filter(x => x.kind === 'exit')
const runsOf = () => jsonl(ARGV)
const E = () => L.__events()
const obs = (id: string) => (E().get(id)!.obligations as any[])
const handoffs = () => readFileSync(join(dir, 'open-handoffs.md'), 'utf8')
let n = 0
const peer = (text: string) => ({ id: `mesh-wo127-${++n}`, source: 'mesh', from: 'eve', verified: true, text, meta: {}, line: 'call',
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
const reminder = () => { const text = '讀信箱（3 封未讀，最舊的等了 70 分鐘）：先用 mailbox_list'
  return { id: `mesh-wo127-${++n}`, source: 'mesh', from: 'fleet-watchdog', verified: true, text, meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail',
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }
type Run = { id: string; lane: string; tok: any; prompt: string; argv: string[] }
/** the run of `lane` that starts next: its token and its argv (the prompt follows -p) */
async function runOf(lane: string, before: number, id: string): Promise<Run> {
  expect(await until(() => !!L.__runTok(lane) && L.__runTok(lane)!.evId === id && runsOf().length > before)).toBe(true)
  const r = runsOf().filter(x => x.lane === lane).at(-1)
  return { id, lane, tok: L.__runTok(lane)!, argv: r.argv, prompt: r.argv[r.argv.indexOf('-p') + 1] }
}
async function start(ev: any): Promise<Run> {
  const before = runsOf().length
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ target: 'lane' })
  return runOf(d.lane!, before, ev.id)
}
async function end(r: Run): Promise<any> {
  writeFileSync(join(tmp, `go-${r.lane}`), 'ok')
  expect(await until(() => L.__runTok(r.lane)?.evId !== r.id)).toBe(true)
  await sleep(40)
  return exits().filter(x => x.event === r.id).at(-1)
}
const call = (r: Run, name: string, a: object) => L.callLaneTool(r.tok, name, a)
const CARD = { decide: '要不要現在重啟 api-gw', recommend: '重啟（5xx 已 12 分鐘）', basis: 'runbook §3：5xx 超過 10 分鐘就重啟', facts: 'netdata api-gw 5xx 3.1%', then: '重啟 api-gw、看 5 分鐘、回 Eve' }
/** what the agent-inbox daemon hands the router after the main's mailbox_decide: BTCC's answer to /decide, made into the event (mail-events.ts) */
const decided = (id: number, decision: string, note: string | null = null) => {
  const it = box.get(id)!
  return decisionEvent({ id, title: it.title, decision, note, lane: it.lane, thread: it.thread, card: it.card, ref: it.ref }) as any
}
/** the main: a stand-in process whose running turn took in the items of these events (as M1 binds them) */
async function mainTurnWith(evIds: string[]): Promise<{ prompt: string; pid: number; sid: string; stop: () => Promise<void> }> {
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  const sid = `00000000-0000-4000-8000-${String(proc.pid).padStart(12, '0')}`
  writeFileSync(join(dir, 'main-expected'), sid)
  await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid, source: 'startup' })
  const prompt = `p-wo127-${Math.random()}`
  const dids = L.__main().items(r => r.state !== 'done' && r.kind !== 'digest' && evIds.includes(String(r.event))).map(r => r.id)
  await L.__mainEvent({ event: 'UserPromptSubmit', pid: proc.pid, prompt_id: prompt, dids })
  return { prompt, pid: proc.pid, sid, stop: async () => { await L.__mainEvent({ event: 'Stop', pid: proc.pid, prompt_id: prompt, phase: 'final' }); await L.__mainEvent({ event: 'SessionEnd', pid: proc.pid }); proc.kill('SIGKILL') } }
}
/** the main's Stop check of that turn (what earlier tests left queued is pulled first: that Stop is passed, as the hook's next one would be) */
async function stopCheck(m: { pid: number; prompt: string }): Promise<any> {
  for (let i = 0; i < 10; i++) { const r = await L.__mainEvent({ event: 'Stop', pid: m.pid, prompt_id: m.prompt }); if (!String(r.block ?? '').startsWith('這一輪先不要結束。')) return r }
  throw new Error('still pulling after 10 Stops')
}
/** an event's M1 item (the main's), and what it says */
const itemOf = (evId: string) => L.__main().items(r => String(r.event) === evId && r.kind !== 'digest').at(-1)
const contentOf = (r: any) => String(r?.notif?.params?.content ?? '')
/** nothing a test leaves behind is owed to the next one's main */
function settle(...ids: string[]): void {
  for (const id of ids) { if (!E().get(id)) continue; E().set(id, o => o.kind === 'main' && o.state === 'open', { state: 'met', by: 'test' }); E().set(id, o => ['joey', 'peer', 'receipt'].includes(o.kind) && (o.state === 'handed' || o.state === 'open'), { state: 'met', by: 'test' }) }
}
/** a reflex lane that asks the main to decide (decide_later), and its run ended; returns the run and the mail id */
async function asked(text = 'api-gw 5xx 一直高，可以重啟嗎？'): Promise<{ r: Run; m: number; out: string }> {
  const r = await start(peer(text))
  const out = await call(r, 'decide_later', { title: 'api-gw 要不要重啟', card: CARD })
  const m = Number(out.match(/#(\d+)/)![1])
  await call(r, 'receipt', { outcome: 'done', happened: 'Eve 問能不能重啟', did: '查了 5xx，放進主線信箱等決定', promised: '無', needs_main: `#${m} 要不要重啟` })
  await end(r)
  return { r, m, out }
}

// ------------------------------------------------------------------ 1-3: the decision comes back, the lane finishes, Joey gets one line
test('WO-127 #1 照建議: decide_later wakes the main with the card; mailbox_decide → the same thread\'s lane resumes and finishes; one line to Joey, the system\'s words in front; the main owes nothing and its Stop check is not held', async () => {
  const before = sent.length
  const { r, m, out } = await asked()
  expect(out).toContain(`放進主線的信箱了（#${m}`); expect(out).toContain('The main was woken with your card')
  expect(mailCalls.find(c => c.name === 'decide_later' && c.args.ref === r.id)).toMatchObject({ lane: r.lane, args: { thread: L.__lanesState().lanes[r.lane].thread, ref: r.id, card: CARD } })
  // item 1: handed to the main as handoff_main hands it (the main is woken now: an owed M1 item), the card in it
  expect(obs(r.id).map(o => `${o.kind}:${o.state}`)).toEqual(expect.arrayContaining(['joey:handed', 'main:open']))
  const item = itemOf(r.id)
  expect(contentOf(item)).toContain(`〔要你決定｜`); expect(contentOf(item)).toContain(`信箱 #${m}`)
  for (const l of B.cardLines(CARD)) if (!l.startsWith('期限')) expect(contentOf(item)).toContain(l)
  expect(contentOf(item)).toContain(`mailbox_decide(id=${m}`); expect(contentOf(item)).toContain('你不用再為這件事回報')
  expect(handoffs()).toContain(`信箱 #${m} 等你決定`)
  // the main's turn takes it and decides
  const mt = await mainTurnWith([r.id])
  try {
    const runs = runsOf().length
    const d = await L.routeEvent(decided(m, 'as_recommended'))
    expect(d).toMatchObject({ rule: 'mail-decision', target: 'lane', lane: r.lane })                   // the same lane, resumed
    expect(L.__events().mainObs(r.id)).toEqual([])                                                  // the main owes nothing for it any more
    expect((await stopCheck(mt)).block).toBeUndefined()                                             // and its Stop check holds nothing
    const dr = await runOf(r.lane, runs, d.lane ? `mail-decision-${m}` : '')
    expect(dr.argv).toContain('--resume')
    expect(dr.prompt).toContain('主線回了決定：照建議。'); expect(dr.prompt).toContain(`信 #${m}`); expect(dr.prompt).toContain('要你決定：要不要現在重啟 api-gw')
    expect(dr.prompt).toContain('說好之後：重啟 api-gw、看 5 分鐘、回 Eve')
    expect(dr.prompt).toContain(B.BOUNDARY_DECISION_SENTENCE)                                         // item 8: the card's sentence rides every run
    expect(await call(dr, 'reply_agent', { to: 'eve', title: 'api-gw 重啟了', ask: '收下就好', text: 'api-gw 已重啟，5xx 回到 0.1%', no_reply: true })).toContain('sent to eve')
    expect(await call(dr, 'notify_joey', { outcome: 'changed', text: 'api-gw 已重啟，5xx 回到 0.1%，Eve 已回覆' })).toContain('sent to Joey')
    await call(dr, 'receipt', { outcome: 'done', happened: '主線照建議', did: '重啟 api-gw', promised: '無', needs_main: '無' })
    expect(await end(dr)).toMatchObject({ decision: 'as_recommended', decision_mail_id: m, decision_outcome: 'done' })
    const lines = sent.slice(before).map(s => s.text)
    expect(lines.length).toBe(1)                                                                    // #10: Joey, one message for the matter
    expect(lines[0]).toContain('照主線的決定（照建議）：api-gw 已重啟')
    expect(E().get(dr.id)!.state).toBe('closed')
    expect(E().get(r.id)!.state).toBe('closed')
    expect(obs(r.id).find(o => o.kind === 'joey')).toMatchObject({ state: 'merged', into: dr.id })
    expect(await until(() => mailCalls.some(c => c.name === 'mailbox_check' && c.args.id === m))).toBe(true)   // the decided lane item is checked off for the lane
    expect(handoffs()).not.toContain(`信箱 #${m}`)
  } finally { await mt.stop() }
}, 40000)

test('WO-127 #2 改成… (and #7 of the ticket\'s items): the note reaches the lane; its line says what the main changed it to; WO-125\'s 〔系統〕 line still rides it', async () => {
  const before = sent.length
  const { r, m } = await asked('api-gw 5xx 很高，要重啟嗎？')
  const runs = runsOf().length
  const d = await L.routeEvent(decided(m, 'changed', '先只重啟一個 replica'))
  const dr = await runOf(d.lane!, runs, `mail-decision-${m}`)
  expect(dr.prompt).toContain('主線回了決定：改成：先只重啟一個 replica。'); expect(dr.prompt).toContain('照主線改過的做')
  expect(L.recordBlocked(dr.tok, { target: 'state/eng-log.md', category: 'file', tool: 'Write' })).toBe(true)   // item 7: WO-125's system facts ride this run too
  await call(dr, 'notify_joey', { outcome: 'changed', text: '只重啟了 replica-2，5xx 降到 0.4%' })
  expect(await end(dr)).toMatchObject({ decision: 'changed', decision_outcome: 'done', blocked_n: 1 })
  const lines = sent.slice(before).map(s => s.text)
  expect(lines.length).toBe(1)
  expect(lines[0]).toContain('照主線的決定（改成：先只重啟一個 replica）：只重啟了 replica-2')
  expect(lines[0].endsWith(`\n${B.blockedLine({ n: 1, targets: ['state/eng-log.md'] })}`)).toBe(true)
  settle(r.id, dr.id)
}, 30000)

test('WO-127 #3 不做: the lane closes it out; Joey gets one line', async () => {
  const before = sent.length
  const { r, m } = await asked('要重啟嗎？')
  const runs = runsOf().length
  const d = await L.routeEvent(decided(m, 'declined'))
  const dr = await runOf(d.lane!, runs, `mail-decision-${m}`)
  expect(dr.prompt).toContain('主線回了決定：不做。'); expect(dr.prompt).toContain('「說好之後」那幾步不做')
  await call(dr, 'reply_agent', { to: 'eve', title: '不重啟', ask: '收下就好', text: '主線決定先不重啟', no_reply: true })
  expect(await call(dr, 'notify_joey', { outcome: 'normal', text: '由主線決定不重啟，已告訴 Eve' })).toContain('sent to Joey')   // saying the main decided is no false claim here
  await call(dr, 'receipt', { outcome: 'done', happened: '主線不做', did: '告訴 Eve', promised: '無', needs_main: '無' })
  expect(await end(dr)).toMatchObject({ decision: 'declined', decision_outcome: 'done' })
  const lines = sent.slice(before).map(s => s.text)
  expect(lines.length).toBe(1); expect(lines[0]).toContain('照主線的決定（不做）：由主線決定不重啟')
  expect(E().get(dr.id)!.state).toBe('closed')
}, 30000)

// ------------------------------------------------------------------ 4, 5: one round trip
test('WO-127 #4: a second decision for the same mail is dropped; a decision\'s run cannot put a second card; handoff_main is the one way back', async () => {
  const { r, m } = await asked('重啟？')
  const runs = runsOf().length
  const d = await L.routeEvent(decided(m, 'as_recommended'))
  const dr = await runOf(d.lane!, runs, `mail-decision-${m}`)
  const lanesBefore = Object.keys(L.__lanesState().lanes).length
  expect(await L.routeEvent(decided(m, 'as_recommended'))).toMatchObject({ rule: 'mail-decision-repeat', target: 'ledger' })    // the inbox daemon sends it again
  expect(await L.routeEvent(decided(m, 'declined'))).toMatchObject({ rule: 'mail-decision-repeat', target: 'ledger' })          // a second decision
  expect(Object.keys(L.__lanesState().lanes).length).toBe(lanesBefore)
  expect(ledger().filter(x => x.refs?.repeat_of === dr.id).length).toBe(2)                                                     // recorded
  const again = await call(dr, 'decide_later', { title: '再問一次', card: { decide: '還要嗎', recommend: '要' } })
  expect(again).toBe(B.DECISION_ASK_AGAIN)
  expect(mailCalls.filter(c => c.name === 'decide_later' && c.args.ref === dr.id)).toEqual([])                                 // nothing put in the mailbox
  expect(await call(dr, 'handoff_main', { text: '重啟失敗（權限），請主線處理' })).toContain('handed to the main')
  expect(await end(dr)).toMatchObject({ decision_outcome: 'handed_back' })
  settle(r.id, dr.id)
}, 30000)

test('WO-127 #4 (mail lane): a decision\'s run on the mail lane cannot card again either', async () => {
  const w = await start(reminder())
  await call(w, 'mailbox_open', { id: 8801 })
  expect(await call(w, 'mailbox_card', { id: 8801, card: { decide: '答不答應 Eve 週五交規格', recommend: '答應' } })).toContain('附上決定卡')
  expect(await call(w, 'handoff_main', { text: '#8801 Eve 要週五交規格，要主線決定' })).toContain('handed to the main')
  await end(w)
  const runs = runsOf().length
  const d = await L.routeEvent(decided(8801, 'as_recommended'))
  const dr = await runOf(d.lane!, runs, 'mail-decision-8801')
  expect(dr.prompt).toContain('這封信照決定回信（mailbox_reply）、勾掉（mailbox_check）')
  expect(await call(dr, 'mailbox_card', { id: 8801, card: { decide: 'x', recommend: 'y' } })).toBe(B.DECISION_ASK_AGAIN)
  await call(dr, 'mailbox_reply', { id: 8801, body: '週五可以' }); await call(dr, 'mailbox_check', { id: 8801 })
  await call(dr, 'notify_joey', { outcome: 'changed', text: '已回 Eve：週五可以' })
  await end(dr)
  expect(mailCalls.filter(c => c.name === 'mailbox_check' && c.args.id === 8801).length).toBe(1)    // a colleague's mail: the mail lane checks it off itself, once
  settle(w.id, dr.id)
}, 30000)

test('WO-127 #5: a decision\'s run that cannot finish hands the whole matter back: the main is woken and sees the card and what the run did', async () => {
  const { r, m } = await asked('重啟 api-gw？')
  const runs = runsOf().length
  const d = await L.routeEvent(decided(m, 'as_recommended'))
  const dr = await runOf(d.lane!, runs, `mail-decision-${m}`)
  await call(dr, 'reply_agent', { to: 'eve', title: '重啟中', ask: '收下就好', text: '正在重啟 api-gw', no_reply: true })
  dr.tok.calls.push({ name: 'Bash', input: { command: './bin/svc POST api-gw/restart' } })
  expect(await call(dr, 'handoff_main', { text: '重啟被擋（要 root），整件交回' })).toContain('handed to the main')
  const it = itemOf(dr.id), c = contentOf(it)
  expect(it.state).not.toBe('done')                                                                // owed to the main: it wakes it
  expect(c).toContain('重啟被擋（要 root），整件交回'); expect(c).toContain('〔系統附上｜一來一回〕主線先前回的決定：照建議')
  expect(c).toContain('要你決定：要不要現在重啟 api-gw'); expect(c).toContain('說好之後：重啟 api-gw、看 5 分鐘、回 Eve')
  expect(c).toContain('reply_agent(mail) → eve：正在重啟 api-gw')                                     // what it did (its ledger)
  expect(c).toContain('Bash `./bin/svc POST api-gw/restart`')                                       // and the tools it used
  expect(obs(dr.id).map(o => `${o.kind}:${o.state}`)).toEqual(expect.arrayContaining(['joey:handed', 'main:open']))
  expect(await end(dr)).toMatchObject({ decision: 'as_recommended', decision_outcome: 'handed_back' })
  settle(r.id, dr.id)
}, 30000)

// ------------------------------------------------------------------ 6: the main does it itself
test('WO-127 #6: the main checks the mail off without deciding: the matter is closed, gone from open-handoffs.md, no reminder later', async () => {
  const before = sent.length
  const { r, m } = await asked('可以把 api-gw 的金鑰換掉嗎？')
  expect(handoffs()).toContain(`- ${r.id}｜來自 eve｜ho-`)
  expect(handoffs()).toContain(`- ${r.id}｜來自 ${r.lane}｜信箱 #${m} 等你決定（mailbox_decide）｜要不要現在重啟 api-gw｜`)
  await L.noteMainMailChecked(m)                                                                    // the agent-inbox daemon, after the main's mailbox_check went through
  expect(obs(r.id).filter(o => o.kind === 'main' || o.kind === 'joey' || (o.kind === 'peer' && o.level === 'answer')).map(o => `${o.kind}:${o.state}`)).toEqual(['joey:met', 'peer:met', 'main:met'])
  expect(E().get(r.id)!.state).toBe('closed')
  expect(handoffs()).not.toContain(r.id)
  L.dueTick(Date.now() + 24 * 3600_000)                                                             // a day later: nothing is reminded
  await sleep(50)
  expect(sent.length).toBe(before)
  expect(ledger().some(x => x.event === r.id && x.text.includes(`自己處理了信箱 #${m}`))).toBe(true)
  settle(r.id)
}, 30000)

// ------------------------------------------------------------------ 7: the lane that asked is gone or too old
test('WO-127 #7: the lane that asked was closed, or is too old: a fresh lane on its thread with the ledger summary finishes it', async () => {
  const a = await asked('重啟 A？')
  const thread = L.__lanesState().lanes[a.r.lane].thread
  expect(await L.lanesCommand(`/lanes close ${a.r.lane}`, 'joey')).toContain(a.r.lane)
  const runs = runsOf().length
  const d = await L.routeEvent(decided(a.m, 'as_recommended'))
  expect(d.lane).not.toBe(a.r.lane); expect(L.__lanesState().lanes[d.lane!]).toMatchObject({ kind: 'reflex', thread, status: expect.anything() })
  const dr = await runOf(d.lane!, runs, `mail-decision-${a.m}`)
  expect(dr.argv).toContain('--session-id')
  expect(dr.prompt).toContain('# 這個 thread 先前的帳本紀錄（原車道已結束太久，由你接手）')
  expect(dr.prompt).toContain('主線回了決定：照建議。')
  await call(dr, 'notify_joey', { outcome: 'changed', text: 'A 重啟了' })
  await end(dr)
  const b = await asked('重啟 B？')
  L.__lanesState().lanes[b.r.lane].last = new Date(Date.now() - 48 * 3600_000).toISOString()         // idle longer than LANES_RESUME_MAX_AGE_MS
  const runs2 = runsOf().length
  const d2 = await L.routeEvent(decided(b.m, 'as_recommended'))
  expect(d2.lane).not.toBe(b.r.lane); expect(d2.note).toContain('too old')
  const dr2 = await runOf(d2.lane!, runs2, `mail-decision-${b.m}`)
  expect(dr2.prompt).toContain('# 這個 thread 先前的帳本紀錄')
  await call(dr2, 'notify_joey', { outcome: 'changed', text: 'B 重啟了' })
  await end(dr2)
  settle(a.r.id, b.r.id, dr.id, dr2.id)
}, 40000)

// ------------------------------------------------------------------ 8: the mail lane with three cards, three decisions in a row
test('WO-127 #8: the mail lane cards three mails; the main answers three in a row: three runs, in order, nothing lost, no line twice', async () => {
  const before = sent.length
  const w = await start(reminder())
  for (const id of [8811, 8812, 8813]) { await call(w, 'mailbox_open', { id }); await call(w, 'mailbox_card', { id, card: { decide: `${id} 答不答應`, recommend: '答應', then: `回信 ${id}` } }) }
  expect(await call(w, 'handoff_main', { text: '三封都要主線決定' })).toContain('handed to the main')
  const c = contentOf(itemOf(w.id))
  for (const id of [8811, 8812, 8813]) { expect(c).toContain(`── 信 #${id} 的決定卡 ──`); expect(c).toContain(`要你決定：${id} 答不答應`) }
  expect(c).toContain('用 mailbox_decide(id, decision) 回')
  await end(w)
  const order: string[] = []
  const runs = runsOf().length
  const ds = [await L.routeEvent(decided(8811, 'as_recommended')), await L.routeEvent(decided(8812, 'changed', '答應但改到下週')), await L.routeEvent(decided(8813, 'declined'))]
  for (const d of ds) expect(d).toMatchObject({ rule: 'mail-decision', target: 'lane', lane: w.lane })
  expect(obs(w.id).find(o => o.kind === 'main')!.state).toBe('met')                                // the hand-over is met once no card of it waits
  // a reminder that comes now is a mailbox run of its own, not merged into a decision's run
  const rem = reminder()
  expect(await L.routeEvent(rem)).toMatchObject({ rule: 'wake-mail', target: 'lane' })
  for (const [i, id] of [8811, 8812, 8813].entries()) {
    const dr = await runOf(w.lane, runs + i, `mail-decision-${id}`)
    order.push(dr.id)
    await call(dr, 'mailbox_reply', { id, body: `回 ${id}` }); await call(dr, 'mailbox_check', { id })
    await call(dr, 'notify_joey', { outcome: 'changed', text: `#${id} 已回信` })
    expect(await call(dr, 'notify_joey', { outcome: 'changed', text: `#${id} 再說一次` })).toContain('one message per event')
    await end(dr)
  }
  expect(order).toEqual(['mail-decision-8811', 'mail-decision-8812', 'mail-decision-8813'])
  const lines = sent.slice(before).map(s => s.text)
  expect(lines.length).toBe(3)
  expect(lines[0]).toContain('照主線的決定（照建議）：#8811 已回信')
  expect(lines[1]).toContain('照主線的決定（改成：答應但改到下週）：#8812 已回信')
  expect(lines[2]).toContain('照主線的決定（不做）：#8813 已回信')
  const remRun = await runOf(w.lane, runsOf().length - 1, rem.id)                                    // then the reminder's own run
  await end(remRun)
  settle(w.id, rem.id)
}, 60000)

test('WO-127 item 1 (mail lane): a run that carded mail and did not hand it over is asked once (the card wakes the main through the hand-over, as today); a card it checked off itself does not count', async () => {
  const w = await start(reminder())
  await call(w, 'mailbox_open', { id: 8821 }); await call(w, 'mailbox_card', { id: 8821, card: { decide: '8821 答不答應', recommend: '答應' } })
  await call(w, 'mailbox_open', { id: 8822 }); await call(w, 'mailbox_card', { id: 8822, card: { decide: '8822 答不答應', recommend: '答應' } })
  await call(w, 'mailbox_check', { id: 8822 })                                                     // it decided 8822 needs nothing after all
  expect(handoffs()).toContain('信箱 #8821 等你決定'); expect(handoffs()).not.toContain('信箱 #8822')
  const held = L.laneStop(w.tok)!
  expect(held).toContain('put decision cards on #8821 but has not handed them to the main'); expect(held).not.toContain('8822')
  expect(L.laneStop(w.tok)).not.toContain('decision cards')                                       // once
  expect(await call(w, 'handoff_main', { text: '#8821 要主線決定' })).toContain('handed to the main')
  const c = contentOf(itemOf(w.id))
  expect(c).toContain('── 信 #8821 的決定卡 ──'); expect(c).not.toContain('#8822 的決定卡')
  await end(w)
  settle(w.id); L.mailChecked(8821, 'main')
}, 30000)

test('WO-127: the decision comes over the agent-inbox daemon\'s path (/lanes/route) while the run that asked is still running: it waits behind that run; a resend is the same decision', async () => {
  const r = await start(peer('重啟 H？'))
  const out = await call(r, 'decide_later', { title: 'H 要不要重啟', card: CARD })
  const m = Number(out.match(/#(\d+)/)![1])
  const route = async (ev: any) => (await fetch(`http://127.0.0.1:${(tgSrv.address() as any).port}/lanes/route`, { method: 'POST', body: JSON.stringify(ev), headers: { Authorization: 'Bearer x' } })).json()
  const d = await route(decided(m, 'as_recommended'))
  expect(d).toMatchObject({ rule: 'mail-decision', target: 'lane', lane: r.lane }); expect(d.note).toContain('queued behind the running run')
  expect(await route(decided(m, 'as_recommended'))).toMatchObject({ rule: 'mail-decision-repeat', target: 'ledger' })   // the inbox daemon did not hear the answer: sends it again
  expect(await call(r, 'notify_joey', { outcome: 'normal', text: '交給主線了' })).toContain('merged into')                 // the matter is the decision's run's now
  const runs = runsOf().length
  await end(r)
  const dr = await runOf(r.lane, runs, `mail-decision-${m}`)
  await call(dr, 'reply_agent', { to: 'eve', title: 'H', ask: '收下就好', text: 'H 已重啟', no_reply: true })
  await call(dr, 'notify_joey', { outcome: 'changed', text: 'H 重啟了' })
  await end(dr)
  expect(E().get(r.id)!.state).toBe('closed'); expect(E().get(dr.id)!.state).toBe('closed')
}, 30000)

// ------------------------------------------------------------------ 9: /clear or a compaction
test('WO-127 #9: after the main\'s session restarts (/clear: a new session in the same process), what waits on a decision is still listed and a decision still routes', async () => {
  const { r, m } = await asked('重啟 C？')
  const mt = await mainTurnWith([r.id])
  await mt.stop()                                                                                   // the turn that took the card ended (the hand-over item is done)
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  const sid = `00000000-0000-4000-8000-${String(proc.pid).padStart(12, '1')}`
  writeFileSync(join(dir, 'main-expected'), sid)
  await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid, source: 'startup' })
  const sid2 = sid.replace(/.$/, '9')
  await L.__mainEvent({ event: 'SessionEnd', pid: proc.pid, session_id: sid, reason: 'clear' })
  await L.__mainEvent({ event: 'SessionStart', pid: proc.pid, session_id: sid2, source: 'clear' })   // /clear
  expect(L.__main().currentGen()).toMatchObject({ session_id: sid2 })
  expect(handoffs()).toContain(`信箱 #${m} 等你決定`)                                                 // the re-anchor file still lists it
  const runs = runsOf().length
  const d = await L.routeEvent(decided(m, 'as_recommended'))
  expect(d).toMatchObject({ rule: 'mail-decision', target: 'lane', lane: r.lane })
  const dr = await runOf(r.lane, runs, `mail-decision-${m}`)
  await call(dr, 'notify_joey', { outcome: 'changed', text: 'C 重啟了' })
  await end(dr)
  expect(handoffs()).not.toContain(`信箱 #${m}`)
  await L.__mainEvent({ event: 'SessionEnd', pid: proc.pid, session_id: sid2 }); proc.kill('SIGKILL')
  settle(r.id, dr.id)
}, 30000)

// ------------------------------------------------------------------ 10: Joey, one message per matter; the other reporter
test('WO-127 #10: LANES_DECISION_REPORTER=main: the main reports (its Stop check holds once, as today); the lane\'s line is not required', async () => {
  process.env.LANES_DECISION_REPORTER = 'main'
  try {
    expect(B.boundaryDefault('adam').join('\n')).toContain('（這件事由主線向 Joey 回報）')
    expect(mainContext('adam', 'sid')).toContain('這件事由你向 Joey 回報一次，寫明你的決定')
    const before = sent.length
    const { r, m } = await asked('重啟 D？')
    expect(contentOf(itemOf(r.id))).toContain('這件事由你向 Joey 回報一次')
    const mt = await mainTurnWith([r.id])
    try {
      const runs = runsOf().length
      const d = await L.routeEvent(decided(m, 'as_recommended'))
      expect(L.__events().mainObs(r.id).map(o => o.kind)).toEqual(['joey'])                          // the Joey line stays the main's
      expect((await stopCheck(mt)).block).toContain('回 Joey 一句')
      L.mainReplied(L.mainReplyTier({}), 9701)                                                        // the main tells Joey
      const dr = await runOf(d.lane!, runs, `mail-decision-${m}`)
      expect(dr.prompt).toContain('這件事由主線向 Joey 回報：你不用通知 Joey')
      expect(await call(dr, 'notify_joey', { outcome: 'normal', text: 'D 重啟了' })).toContain('owes Joey no line')   // not required: nothing new goes out
      expect(await call(dr, 'reply_agent', { to: 'eve', title: 'D 重啟了', ask: '收下就好', text: 'D 已重啟', no_reply: true })).toContain('sent to eve')   // Eve's answer is the lane's
      await call(dr, 'receipt', { outcome: 'done', happened: '照建議', did: '重啟 D', promised: '無', needs_main: '無' })
      await end(dr)
      expect(sent.length).toBe(before)                                                                 // the lane sent nothing; the main's own reply is its
      expect(E().get(dr.id)!.state).toBe('closed')
    } finally { await mt.stop() }
    settle(r.id)
  } finally { delete process.env.LANES_DECISION_REPORTER }
}, 30000)

// ------------------------------------------------------------------ mail_due: information only
test('WO-127: a card entering its due window (mail_due) rides the main\'s next digest: it wakes nobody and owes Joey nothing', async () => {
  const { r, m } = await asked('重啟 E？')
  const dg = L.__digest()                                                                               // what the earlier tests left is shown (a digest reached the main)
  if (dg) L.__journal().write('msg', `dg-wo127-${Date.now()}`, 'done', { kind: 'digest', events: dg.fields.events })
  const queuedBefore = L.__main().items(r => r.state === 'queued' && r.kind !== 'digest').length
  const it = box.get(m)!
  const ev = dueEvent({ id: m, title: it.title, deadline: it.deadline, overdue: false, decide: CARD.decide, recommend: CARD.recommend, lane: it.lane, thread: it.thread, ref: it.ref }) as any
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ rule: 'mail-due', target: 'ledger' })
  expect(L.__main().items(r => r.state === 'queued' && r.kind !== 'digest').length).toBe(queuedBefore)   // no item: nobody is woken
  expect(E().get(ev.id)).toMatchObject({ owner: 'router', state: 'closed', obligations: [] })           // no Joey line, no answer owed
  expect(L.__events().mainObs(ev.id)).toEqual([])
  const next = L.__digest()!
  expect(next.text).toContain(`〔信箱｜等你決定，快到期〕#${m}`); expect(next.text).toContain('只記錄（資訊）')   // the next delivery carries it
  expect(Object.keys(next.fields.events as object)).toEqual([ev.id])
  expect(await L.routeEvent(ev)).toMatchObject({ rule: 'mail-due' })                                     // a repeat: the same record
  settle(r.id)
}, 30000)

// ------------------------------------------------------------------ 11: the observation points
test('WO-127 #11: the observation points: the run that asked has decide_later_mail_id; a decision\'s run has decision, decision_mail_id, decision_outcome', async () => {
  const { r, m } = await asked('重啟 F？')
  expect(exits().filter(x => x.event === r.id).at(-1)).toMatchObject({ decide_later_mail_id: m })
  expect('decision' in exits().filter(x => x.event === r.id).at(-1)).toBe(false)
  const runs = runsOf().length
  const d = await L.routeEvent(decided(m, 'declined', '這週不動'))
  const dr = await runOf(d.lane!, runs, `mail-decision-${m}`)
  await call(dr, 'notify_joey', { outcome: 'normal', text: 'F 不重啟' })
  const x = await end(dr)
  expect(x).toMatchObject({ decision: 'declined', decision_mail_id: m, decision_outcome: 'done' })
  expect('decide_later_mail_id' in x).toBe(false)
  const other = await start(peer('早'))
  await call(other, 'notify_joey', { outcome: 'normal', text: '早' })
  const ox = await end(other)
  for (const k of ['decision', 'decision_mail_id', 'decision_outcome', 'decide_later_mail_id']) expect(k in ox).toBe(false)   // only on the runs they are about
  settle(r.id, other.id)
}, 30000)

// ------------------------------------------------------------------ the pieces: tools, words, the rule, the seam's wiring
test('WO-127: the lane tools are Epeius\'s definitions minus what the daemon fills; decide_later for every lane, mailbox_card for the mail lane; the card\'s hash does not change', () => {
  for (const kind of ['reflex', 'worker', 'fork', 'curator', 'synthesis', 'mail'] as const) {
    const names = L.laneToolsFor(kind).map((t: any) => t.name)
    expect(names).toContain('decide_later')
    expect(names.includes('mailbox_card')).toBe(kind === 'mail')
  }
  const dl = L.laneToolsFor('reflex').find((t: any) => t.name === 'decide_later')
  expect(dl.description).toBe(LANE_DECIDE_LATER_TOOL.description)
  expect(Object.keys(dl.inputSchema.properties)).toEqual(['title', 'card', 'deadline'])               // ref and thread are the daemon's
  expect(dl.inputSchema.properties.card).toEqual(LANE_DECIDE_LATER_TOOL.inputSchema.properties.card)
  expect(Object.keys(L.laneToolsFor('mail').find((t: any) => t.name === 'mailbox_card').inputSchema.properties)).toEqual(['id', 'card'])
  expect(L.laneToolsFor('mail').find((t: any) => t.name === 'mailbox_card').description).toBe(MAILBOX_CARD_TOOL.description)
  const h = Object.fromEntries((['reflex', 'mail', 'worker'] as const).map(k => [k, L.cardHash(k)]))
  process.env.LANES_DECISIONS = '0'
  try { for (const k of ['reflex', 'mail', 'worker'] as const) expect(L.cardHash(k)).toBe(h[k]) } finally { delete process.env.LANES_DECISIONS }
})

test('WO-127 item 8: the words, verbatim: the boundary card\'s sentence right after 「…你說好之後還剩哪幾步。」 (same line: the card still has 10 lines); the main\'s rule right after the boundary card\'s', () => {
  const card = B.boundaryDefault('adam')
  expect(card.length).toBe(10)
  expect(card.find(l => l.includes('你說好之後還剩哪幾步。'))!.endsWith('你說好之後還剩哪幾步。主線回了決定：照決定把剩下的做完，向 Joey 回報一次，寫明是照主線的決定。做不下去就整件交給主線，不再問第二次。')).toBe(true)
  const ctx = mainContext('adam', 'sid').split('\n')
  const i = ctx.indexOf(B.BOUNDARY_MAIN_RULE)
  expect(ctx[i + 1]).toBe('- 分身交來要你決定的事附著決定卡。照卡就能決定的：用 mailbox_decide 回（照建議／改成…／不做），原本那條分身會接著做完並向 Joey 回報，你不用再為這件事回報。收不回的動作、要你這段對話才知道的事：你自己做，做完那一件就算結掉。收不回的事和真金，先看原文再決定。')
})

test('WO-127: the fleet router has the mail rule; a router.json that predates it gets it from the code; the inbox side takes the two calls; server.ts wires the seam', async () => {
  const fleet = JSON.parse(readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
  expect(fleet.rules[0]).toEqual({ id: 'mail-event', match: { source: 'mail' }, to: 'mail_event' })
  expect(JSON.parse(readFileSync(join(dir, 'router.json'), 'utf8')).rules.some((r: any) => r.to === 'mail_event')).toBe(false)   // the lab router: the code's rule routed every test above
  // the agent-inbox daemon's /lanes/mail-tool: decide_later for any lane, mailbox_card for the mail lane only
  const I = await import('./lanes.ts?wo127-inbox') as typeof import('./lanes.ts')
  const got: any[] = []
  I.lanesInit({ role: 'inbox', agent: 'adam', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => true,
    mailTool: async (name: string, args: any, lane: string) => { got.push({ name, args, lane }); return { text: 'ok', isError: false, mail_id: 1 } } } as any)
  const srv = createServer(async (req, res) => { if (!(await I.handleLanesHttp(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res))) res.writeHead(404).end() })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  const post = async (b: object) => (await fetch(`http://127.0.0.1:${(srv.address() as any).port}/lanes/mail-tool`, { method: 'POST', body: JSON.stringify(b), headers: { Authorization: 'Bearer x' } })).json()
  try {
    expect(await post({ name: 'decide_later', args: { title: 't' }, lane: 'adam.reflex.3' })).toMatchObject({ isError: false, mail_id: 1 })
    expect(await post({ name: 'mailbox_card', args: { id: 5 }, lane: 'adam.reflex.3' })).toMatchObject({ isError: true })
    expect(await post({ name: 'mailbox_card', args: { id: 5 }, lane: 'adam.mail.1' })).toMatchObject({ isError: false })
    expect(await post({ name: 'mailbox_decide', args: { id: 5 }, lane: 'adam.mail.1' })).toMatchObject({ isError: true })          // the main's, never a lane's
    expect(got.map(g => g.name)).toEqual(['decide_later', 'mailbox_card'])
  } finally { srv.close() }
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain("const res: any = await callInboxTool(name, args, { ...fleetDeps, btcc, openBy: 'lane', lane }, false)")      // the lane's card, its id back to the router
  expect(src).toContain("if (checked && r.status === 200) await Lanes.noteMainMailChecked(Number(checked[1]))")                    // the main's check-off
  expect(src).toContain("const res: any = await callInboxTool(name, args, { ...fleetDeps, openBy: 'lane', lane }, false)")        // the four mailbox tools as before
})

// ------------------------------------------------------------------ 12: the switch off
test('WO-127 #12: LANES_DECISIONS=0: as 1.37.2: no tool, no rule (the mailbox\'s events go to the main), no sentence; prompts and tool lists as before', async () => {
  const lane = { id: 'adam.reflex.990', kind: 'reflex', n: 990, session_id: 's990', thread: 'adam#t-990', status: 'idle', created: '', last: '', transcript: '', runs: 1, tokens_in: 0, tokens_out: 0 } as any
  const it = { ev: { id: 'mesh-wo127-ctx', source: 'mesh', from: 'eve', text: 'x', meta: {}, notif: { method: '', params: {} } } } as any
  const onCtx = L.laneContext(lane, it), onMain = mainContext('adam', 'sid'), onTools = Object.fromEntries((['reflex', 'mail'] as const).map(k => [k, L.laneToolsFor(k).map((t: any) => t.name)]))
  process.env.LANES_DECISIONS = '0'
  try {
    expect(L.laneContext(lane, it)).toBe(onCtx.replace(B.BOUNDARY_DECISION_SENTENCE, ''))
    expect(mainContext('adam', 'sid')).toBe(onMain.replace(`\n${B.DECISION_MAIN_RULE}`, ''))
    expect(B.boundaryDefault('adam').join('\n')).not.toContain('主線回了決定')
    expect(L.laneToolsFor('reflex').map((t: any) => t.name)).toEqual(onTools.reflex.filter((x: string) => x !== 'decide_later'))
    expect(L.laneToolsFor('mail').map((t: any) => t.name)).toEqual(onTools.mail.filter((x: string) => !['decide_later', 'mailbox_card'].includes(x)))
    const r = await start(peer('重啟 G？'))
    await expect(call(r, 'decide_later', { title: 't', card: CARD })).rejects.toThrow('unknown lane tool decide_later')
    expect(await call(r, 'handoff_main', { text: '要主線決定重啟' })).toBe('handed to the main: it gets your text, takes over and reports to Joey. Do not notify Joey about this yourself; close with receipt.'
      + ' The router told eve: "' + meshOut.at(-1).text + '" The answer is the main\'s now. You may still tell eve your own part (what you are doing, by when) with reply_agent, once; do not answer for the main.')
    expect(contentOf(itemOf(r.id))).toMatch(/^〔交給主線｜ho-[0-9a-f]+〕要主線決定重啟\n（這件事交給你了：處理完由你回報 Joey 一次。）$/)
    const x = await end(r)
    for (const k of ['decision', 'decision_mail_id', 'decision_outcome', 'decide_later_mail_id']) expect(k in x).toBe(false)
    // the mailbox's events: the default rule, the main, as 1.37.2 measured them (Epeius #11000)
    const dEv = decisionEvent({ id: 12799, title: 't', decision: 'as_recommended', note: null, lane: r.lane, thread: L.__lanesState().lanes[r.lane].thread, card: CARD, ref: r.id }) as any
    expect(await L.routeEvent(dEv)).toMatchObject({ rule: 'default', target: 'main' })
    expect(obs(dEv.id).map(o => o.kind)).toEqual(['main', 'joey'])
    const uEv = dueEvent({ id: 12798, title: 't', deadline: '2026-11-24T13:00:00.000Z', overdue: false, decide: 'x', recommend: 'y', lane: r.lane, thread: null, ref: null }) as any
    expect(await L.routeEvent(uEv)).toMatchObject({ rule: 'default', target: 'main' })
    expect(L.mailChecked(12799, 'main')).toBe(0)
    settle(r.id, dEv.id, uEv.id)
  } finally { delete process.env.LANES_DECISIONS }
}, 30000)
