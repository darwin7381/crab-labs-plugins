// WO-128 (telegram-http 1.39.0): what can wait does not wake the main (Chiron's ticket; Joey TG chiron:2081, 2083, 2095). A lane uses toward its main the
// same three lines as toward a colleague: nothing to do → record; the main must decide and it can wait → its mailbox, the main is not woken; it cannot wait
// → wake the main, saying what breaks or who is waiting. decide_later and mailbox_card take `urgent_because`; without it the card can wait: its hand-over
// waits in the main's mailbox (no M1 item, no due time), every delivery to the main carries 「信箱有 N 件等你決定」 in its digest, and the card's mail_due
// (15 minutes before its deadline) is its one wake, from which the 300 s push counts. open-handoffs.md lists no cards; the context the main gets back
// (registration, a resumed main's first prompt, after a compaction) carries the mailbox's count and titles. LANES_DEFER_DECISIONS=0: 1.38 (every card wakes).
// The tests are named after the ticket's acceptance list (怎樣算完成 1-10). The mailbox (BTCC) is a stand-in that answers as BTCC does; mail-events.ts builds
// the events the agent-inbox daemon hands the router; the main is a stand-in process whose Telegram stream is open (an idle main is offered items: that
// offer is a wake) and whose turns the test drives through its hook events.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
import { randomUUID } from 'crypto'
import { decisionEvent, dueEvent } from './mail-events.ts'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?wo128') as typeof import('./lanes.ts')
const B = await import('./lanes-boundary.ts')
const { mainContext } = await import('./lanes-main.ts')
const { LANE_DECIDE_LATER_TOOL, MAILBOX_CARD_TOOL } = await import('./fleet-mail.ts')

const ws = mkdtempSync(join(tmpdir(), 'lanes-wo128-ws-'))
const dir = join(ws, '.lanes'); mkdirSync(dir)
const tmp = mkdtempSync(join(tmpdir(), 'lanes-wo128-'))
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
// the mailbox, as BTCC answers through fleet-mail.ts; each card's deadline is an hour out (the lane item's default) unless the test sets one
type Item = { id: number; lane: string; thread: string; ref: string | null; card: any; title: string; deadline: string }
const box = new Map<number, Item>()
const mailCalls: any[] = []
let nextId = 12800, nextDeadline: string | null = null
const hourOut = (min = 60) => new Date(Date.now() + min * 60_000).toISOString()
L.__setMailTool(async b => {
  mailCalls.push(b)
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
  if (b.name === 'mailbox_reply') return { text: '回信放進對方信箱了（#9901，不用回）。', isError: false, to: 'eve' }
  if (b.name === 'mailbox_open') return { text: `#${a.id} 來自 eve`, isError: false }
  return { text: '1 封未讀', isError: false }
})
const meshOut: any[] = []
L.__setMeshSend(async b => { meshOut.push(b); return { text: `sent to ${b.to}`, msgId: 72000 + meshOut.length, delivered: true } })
const sent: Array<{ text: string; silent: boolean }> = []
const open = new Set<string>()
const offers: any[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve'],
  notifySession: async (sid: string, notif: any) => { if (!open.has(sid)) return false; offers.push(notif); return true }, streamOpen: (sid: string) => open.has(sid), toolsChanged: () => {},
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 9600 + sent.length }, joeyChatId: () => '1' } as any)
const procs: any[] = []
afterAll(() => { for (const f of Object.keys(L.__lanesState().lanes)) try { writeFileSync(join(tmp, `go-${f}`), 'ok') } catch {}
  for (const p of procs) try { p.kill('SIGKILL') } catch {}
  L.__setClaudeBin(restore); L.__setMailTool(null); L.__setMeshSend(null); L.__setMailWaiting(null)
  for (const k of ['LANES_FLOOD_CONTROL', 'LANES_DEFER_DECISIONS', 'LANES_MAILBOX_READ_MS']) delete process.env[k]
  rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const jsonl = (p: string): any[] => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const laneRows = () => jsonl(join(dir, 'lanes.jsonl'))
const wakes = () => laneRows().filter(x => x.kind === 'main_wake')
const runsOf = () => jsonl(ARGV)
const E = () => L.__events(), M = () => L.__main()
const ob = (id: string, kind: string) => (E().get(id)?.obligations ?? []).find((o: any) => o.kind === kind && (kind !== 'main' || o.state === 'open')) ?? (E().get(id)?.obligations ?? []).find((o: any) => o.kind === kind)
const itemsOf = (ev: string) => M().items(r => String(r.event) === ev && r.kind !== 'digest')
const handoffs = () => readFileSync(join(dir, 'open-handoffs.md'), 'utf8')
const contentOf = (n: any) => String(n?.params?.content ?? '')
let n = 0
const peer = (text: string) => ({ id: `mesh-wo128-${++n}`, source: 'mesh', from: 'eve', verified: true, text, meta: {}, line: 'call',
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any)
const reminder = () => { const text = '讀信箱（2 封未讀，最舊的等了 70 分鐘）：先用 mailbox_list'
  return { id: `mesh-wo128-${++n}`, source: 'mesh', from: 'fleet-watchdog', verified: true, text, meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail',
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }
let tgN = 5000
const joey = (text: string) => { const id = String(++tgN), meta = { chat_id: '1', message_id: id, user: 'joey_lab' }
  return { id: `tg-1-${id}`, source: 'telegram', from: 'joey', text, meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any }
type Run = { id: string; lane: string; tok: any }
async function runOf(lane: string, before: number, id: string): Promise<Run> {
  expect(await until(() => !!L.__runTok(lane) && L.__runTok(lane)!.evId === id && runsOf().length > before)).toBe(true)
  return { id, lane, tok: L.__runTok(lane)! }
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
  return laneRows().filter(x => x.kind === 'exit' && x.event === r.id).at(-1)
}
const call = (r: Run, name: string, a: object) => L.callLaneTool(r.tok, name, a)
const CARD = { decide: '要不要現在重啟 api-gw', recommend: '重啟（5xx 已 12 分鐘）', basis: 'runbook §3', then: '重啟 api-gw、看 5 分鐘、回 Eve' }
const decided = (id: number, decision = 'as_recommended') => { const it = box.get(id)!
  return decisionEvent({ id, title: it.title, decision, note: null, lane: it.lane, thread: it.thread, card: it.card, ref: it.ref }) as any }
const due = (id: number) => { const it = box.get(id)!
  return dueEvent({ id, title: it.title, decide: it.card.decide, recommend: it.card.recommend, deadline: it.deadline, lane: it.lane, thread: it.thread, ref: it.ref }) as any }
/** the main: a stand-in process registered as this agent's main, its Telegram stream open (an idle main is offered what it is owed) */
type Main = { pid: number; sid: string; hook: (event: string, o?: object) => Promise<any>; kill: () => Promise<void> }
async function mainUp(source = 'startup'): Promise<Main> {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const sid = randomUUID(); writeFileSync(join(dir, 'main-expected'), sid); open.add(`mcp-${p.pid}`); L.__noteMcpPid(`mcp-${p.pid}`, p.pid)
  const hook = (event: string, o: object = {}) => L.__mainEvent({ event, pid: p.pid, session_id: sid, ...o } as any)
  await hook('SessionStart', { source })
  return { pid: p.pid, sid, hook, kill: async () => { await hook('SessionEnd'); p.kill('SIGKILL') } }
}
/** the main's turn takes the items of these events (the offer names them: did) */
async function takes(m: Main, evs: string[], prompt: string): Promise<void> {
  await m.hook('UserPromptSubmit', { prompt_id: prompt, dids: M().items(r => r.state !== 'done' && evs.includes(String(r.event))).map(r => r.id) })
}
/** a reflex lane puts a card in the mailbox (decide_later) and ends; the mail id and the tool's answer */
async function asked(text: string, extra: object = {}): Promise<{ r: Run; m: number; out: string; exit: any }> {
  const r = await start(peer(text))
  const out = await call(r, 'decide_later', { title: `${text.slice(0, 12)}：要不要重啟`, card: CARD, ...extra })
  const m = Number(out.match(/#(\d+)/)![1])
  await call(r, 'receipt', { outcome: 'done', happened: 'Eve 問能不能重啟', did: '放進主線信箱等決定', promised: '無', needs_main: `#${m}` })
  return { r, m, out, exit: await end(r) }
}
/** nothing a test leaves behind is owed to the next one's main */
function settle(...ids: string[]): void {
  for (const id of ids) { if (!E().get(id)) continue; E().set(id, o => o.kind === 'main' && o.state === 'open', { state: 'met', by: 'test' }); E().set(id, o => ['joey', 'peer', 'receipt'].includes(o.kind) && (o.state === 'handed' || o.state === 'open'), { state: 'met', by: 'test' }) }
  for (const e of E().rows(r => ids.includes(r.id))) if (Array.isArray(e.waits)) E().note(e.id, { waits: e.waits.map((w: any) => w.decided || w.checked ? w : { ...w, checked: { by: 'test', at: new Date().toISOString() } }) })
}
const cardLine = (m: number) => `• #${m}「${box.get(m)!.title}」｜要你決定：要不要現在重啟 api-gw｜期限 `
const pushesAbout = (from: number, m: number) => sent.slice(from).filter(s => s.text.includes(`#${m}`) || s.text.includes(box.get(m)!.title))

// ------------------------------------------------------------------ 1, 8, 9: a card that can wait does not wake the main; the next wake carries it
test('WO-128 #1, #8, #9: a can-wait card does not wake the main (no item, no push, no main_wake); the next wake for another reason (Joey) carries 「信箱有 1 件等你決定」 and its line; the decision comes back as in WO-127, Joey gets one line', async () => {
  const m0 = await mainUp()
  const k = sent.length, w0 = wakes().length, o0 = offers.length
  const { r, m, out, exit } = await asked('api-gw 5xx 一直高，可以重啟嗎？')
  expect(out).toContain('It can wait: the main is not woken for it')
  expect(itemsOf(r.id)).toEqual([])                                                                  // no M1 item: nothing to offer
  expect(offers.length).toBe(o0); expect(wakes().length).toBe(w0)
  expect(ob(r.id, 'main')).toMatchObject({ state: 'open', defer: true, card: true }); expect(ob(r.id, 'main').due_at).toBeUndefined(); expect(ob(r.id, 'main').item).toBeUndefined()
  expect(ob(r.id, 'joey')).toMatchObject({ state: 'handed' })                                         // the main's until the decision comes back
  expect(meshOut.at(-1)).toMatchObject({ to: 'eve' }); expect(meshOut.at(-1).text).toContain('主線會在')   // the router's interim: answered by the card's deadline
  expect(exit).toMatchObject({ reason: 'normal', card_urgency: 'defer', decide_later_mail_id: m })
  expect(sent.slice(k)).toEqual([])                                                                   // #8: no push when the card is opened
  L.dueTick(Date.now() + 40 * 60_000); await sleep(20)
  expect(sent.slice(k)).toEqual([])                                                                   // nothing is due before the card's due wake
  expect(handoffs()).not.toContain(`#${m}`)                                                           // #6: not a line of open-handoffs.md
  // the next wake, for another reason: Joey writes to the main
  const j = joey('主線在嗎？幫我看一下今天的部署')
  expect(await L.routeEvent(j)).toMatchObject({ target: 'main' })
  expect(await until(() => offers.length > o0)).toBe(true)
  const got = contentOf(offers.at(-1))
  expect(got).toContain('〔信箱有 1 件等你決定'); expect(got).toContain(cardLine(m))
  expect(got).toContain('主線在嗎？幫我看一下今天的部署')
  expect(wakes().slice(w0)).toMatchObject([{ kind: 'main_wake', cause: 'other', event: j.id }])        // #9: one wake, cause other
  await takes(m0, [j.id], 'p-128-1')
  const runs = runsOf().length
  const d = await L.routeEvent(decided(m))
  expect(d).toMatchObject({ rule: 'mail-decision', target: 'lane', lane: r.lane })
  expect(ob(r.id, 'main')).toMatchObject({ state: 'met' })
  const dr = await runOf(r.lane, runs, `mail-decision-${m}`)
  expect(await call(dr, 'reply_agent', { to: 'eve', title: 'api-gw 重啟了', ask: '收下就好', text: 'api-gw 已重啟', no_reply: true })).toContain('sent to eve')   // the answer Eve was owed came back with the decision
  expect(await call(dr, 'notify_joey', { outcome: 'changed', text: 'api-gw 已重啟，5xx 回到 0.1%' })).toContain('sent to Joey')
  await call(dr, 'receipt', { outcome: 'done', happened: '主線照建議', did: '重啟', promised: '無', needs_main: '無' })
  await end(dr)
  L.mainReplied(L.mainReplyTier({}), 9690)
  await m0.hook('Stop', { prompt_id: 'p-128-1', phase: 'final' })
  expect(sent.slice(k).map(s => s.text)).toEqual([expect.stringContaining('照主線的決定（照建議）：api-gw 已重啟')])   // #8: Joey, one message for the matter
  expect(L.__digest()?.text ?? '').not.toContain('信箱有')                                             // decided: nothing waits
  await m0.kill()
}, 40000)

// ------------------------------------------------------------------ 2, 8: nobody handles it: one due wake, one push 300 s after it
test('WO-128 #2, #8: a can-wait card nobody handles: no push before its due wake; mail_due is its one wake; the push comes only 300 s after that wake, once (a peer\'s answer due later on the same matter does not push again)', async () => {
  const k = sent.length
  const { r, m } = await asked('api-gw 的 timeout 可以改成 30 秒嗎？')
  L.dueTick(Date.now() + 44 * 60_000); await sleep(20)
  expect(pushesAbout(k, m)).toEqual([])
  const d = await L.routeEvent(due(m))                                                                 // 15 minutes before the deadline (no main is up)
  expect(d).toMatchObject({ rule: 'mail-due-wake', target: 'ledger' })
  const o = ob(r.id, 'main')
  expect(o).toMatchObject({ state: 'open', defer: true, woke: 'due' }); expect(o.item).toBeTruthy()
  expect(o.due_at).toBeGreaterThan(Date.now() + 290_000); expect(o.due_at).toBeLessThanOrEqual(Date.now() + 300_000)   // the 300 s count from this wake
  expect(contentOf(itemsOf(r.id).at(-1)!.notif)).toContain(`〔要你決定｜快到期｜${o.handoff}｜信箱 #${m}〕`)
  expect((await L.routeEvent({ ...due(m), id: `${due(m).id}-again` })).rule).toBe('mail-due')          // a second due event: no second wake
  expect(itemsOf(r.id).length).toBe(1)
  L.dueTick(o.due_at - 1); await sleep(20)
  expect(pushesAbout(k, m)).toEqual([])
  L.dueTick(o.due_at + 1); L.dueTick(o.due_at + 2); await sleep(20)
  // WO-201 (point 5), inverted: no main is up (it cannot act): the card-due push waits for one (1.59.0 pushed here: 「…5 分鐘了還沒處理（主線現在不在線）」).
  // The push after the main is back and still has not handled it: lanes-wo201.test.ts (f)
  expect(pushesAbout(k, m)).toEqual([]); expect(ob(r.id, 'main').told).toBeUndefined()
  L.dueTick(Date.parse(box.get(m)!.deadline) + 1); await sleep(20)                                     // the peer's answer is due at the deadline: answer-due is not WO-201's
  expect(pushesAbout(k, m).filter(s => s.text.includes('快到期叫醒主線'))).toEqual([])
  expect(pushesAbout(k, m).length).toBeLessThanOrEqual(1)
  // the main comes up: the due wake reaches it (cause due); it decides
  const w0 = wakes().length
  const m0 = await mainUp()
  expect(await until(() => wakes().length > w0)).toBe(true)
  expect(wakes().slice(w0)).toMatchObject([{ cause: 'due', event: r.id, handoff: o.handoff }])
  await takes(m0, [r.id], 'p-128-2')
  const runs = runsOf().length
  await L.routeEvent(decided(m, 'declined'))
  const dr = await runOf(r.lane, runs, `mail-decision-${m}`)
  await call(dr, 'reply_agent', { to: 'eve', title: '不改 timeout', ask: '收下就好', text: '主線決定不改', no_reply: true })
  await call(dr, 'notify_joey', { outcome: 'normal', text: '主線決定不改 timeout，已告訴 Eve' })
  await call(dr, 'receipt', { outcome: 'done', happened: '不做', did: '告訴 Eve', promised: '無', needs_main: '無' })
  await end(dr)
  await m0.hook('Stop', { prompt_id: 'p-128-2', phase: 'final' })
  await m0.kill()
  settle(r.id, dr.id)
}, 40000)

// ------------------------------------------------------------------ 3, 9: cannot wait
test('WO-128 #3, #9: a card with urgent_because wakes the main now (its reason in the item; main_wake urgent_handoff; card_urgency urgent); a blank reason is no reason: it can wait', async () => {
  const m0 = await mainUp()
  const w0 = wakes().length
  const a = await asked('api-gw 全掛了，現在重啟嗎？', { urgent_because: 'api-gw 全部 5xx，讀者打不開，Eve 在等' })
  expect(a.out).toContain('The main was woken with your card')
  expect(ob(a.r.id, 'main')).toMatchObject({ state: 'open', woke: 'urgent', card: true }); expect(ob(a.r.id, 'main').defer).toBeUndefined()
  expect(await until(() => wakes().length > w0)).toBe(true)
  expect(wakes().slice(w0)).toMatchObject([{ cause: 'urgent_handoff', event: a.r.id, item_kind: 'carry' }])
  expect(contentOf(offers.at(-1))).toContain(`等不起（${a.r.lane} 寫的）：api-gw 全部 5xx，讀者打不開，Eve 在等`)
  expect(a.exit).toMatchObject({ card_urgency: 'urgent' })
  const ledgerRow = jsonl(join(dir, 'ledger.jsonl')).find(x => x.event === a.r.id && x.refs?.decide_later === a.m)
  expect(ledgerRow.text).toContain('；等不起：api-gw 全部 5xx'); expect(ledgerRow.refs.urgency).toBe('urgent')
  expect(mailCalls.find(c => c.name === 'decide_later' && c.args.ref === a.r.id).args.urgent_because).toBeUndefined()   // not sent to BTCC
  const b = await asked('api-gw 有點慢，要重啟嗎？', { urgent_because: '   ' })
  expect(b.out).toContain('It can wait'); expect(ob(b.r.id, 'main')).toMatchObject({ defer: true }); expect(itemsOf(b.r.id)).toEqual([])
  expect(b.exit).toMatchObject({ card_urgency: 'defer' })
  expect(wakes().length).toBe(w0 + 1)
  await m0.kill()
  settle(a.r.id, b.r.id)
}, 40000)

// ------------------------------------------------------------------ 4: three in an hour, one wake
test('WO-128 #4: three can-wait cards within an hour: the main is woken once (the earliest card\'s due wake), all three are listed in what it gets; it decides all three', async () => {
  const m0 = await mainUp()
  const w0 = wakes().length, k = sent.length
  const three: Array<{ r: Run; m: number }> = []
  for (const [i, min] of [[1, 50], [2, 55], [3, 58]] as const) { nextDeadline = hourOut(min); three.push(await asked(`第 ${i} 件：service-${i} 要重啟嗎？`)) }
  nextDeadline = null
  expect(wakes().length).toBe(w0)                                                                     // none of the three woke the main
  await L.routeEvent(due(three[0].m))                                                                  // the earliest is due first
  expect(await until(() => wakes().length > w0)).toBe(true)
  const got = contentOf(offers.at(-1))
  expect(got).toContain('〔信箱有 3 件等你決定')
  for (const t of three) expect(got).toContain(`• #${t.m}「`)
  expect(got.indexOf(`• #${three[0].m}`)).toBeLessThan(got.indexOf(`• #${three[2].m}`))               // soonest first
  await takes(m0, [three[0].r.id], 'p-128-4')
  for (const t of three) {
    const runs = runsOf().length
    await L.routeEvent(decided(t.m))
    const dr = await runOf(t.r.lane, runs, `mail-decision-${t.m}`)
    await call(dr, 'reply_agent', { to: 'eve', title: 'service 重啟了', ask: '收下就好', text: `重啟了（#${t.m}）`, no_reply: true })
    await call(dr, 'notify_joey', { outcome: 'changed', text: `service 重啟了（#${t.m}）` })
    await call(dr, 'receipt', { outcome: 'done', happened: '照建議', did: '重啟', promised: '無', needs_main: '無' })
    await end(dr)
  }
  for (const t of three.slice(1)) expect((await L.routeEvent(due(t.m))).rule).toBe('mail-due')       // decided before their due time: no wake
  await m0.hook('Stop', { prompt_id: 'p-128-4', phase: 'final' })
  expect(wakes().slice(w0).length).toBe(1)
  expect(wakes().slice(w0)[0]).toMatchObject({ cause: 'due', event: three[0].r.id })
  expect(sent.slice(k).length).toBe(3)                                                                 // one line per matter, from the lanes that finished them
  await m0.kill()
}, 60000)

// ------------------------------------------------------------------ 5: the context the main gets back
test('WO-128 #5: after a /clear, a compaction and a restart (and on a resumed main\'s first prompt) the context the main gets back has the mailbox\'s count and titles; unreadable: one line that says so', async () => {
  const items = [{ id: 501, title: '要不要延後部署', decide: '延後到週五嗎', deadline: hourOut(30), overdue: false }, { id: 502, title: 'Eve 的規格', decide: '答應週五交嗎', deadline: hourOut(600), overdue: false }]
  let answer: any = { ok: true, items }
  L.__setMailWaiting(async () => answer)
  const has = (t: string) => { expect(t).toContain('〔信箱有 2 件等你決定（從信箱讀的'); expect(t).toContain('• #501「要不要延後部署」｜要你決定：延後到週五嗎｜期限 '); expect(t).toContain('• #502「Eve 的規格」') }
  const m0 = await mainUp()                                                                           // a restart: the new process registers (startup)
  const r0 = await L.__mainEvent({ event: 'SessionStart', pid: m0.pid, session_id: m0.sid, source: 'startup' })
  expect(r0.additionalContext).toContain('你是 adam 的主線'); has(r0.additionalContext)
  const sid2 = randomUUID()                                                                            // /clear: the same process, a new session
  has((await L.__mainEvent({ event: 'SessionStart', pid: m0.pid, session_id: sid2, source: 'clear' })).additionalContext)
  await L.__mainEvent({ event: 'PreCompact', pid: m0.pid, session_id: sid2 })                          // a compaction
  has((await L.__mainEvent({ event: 'SessionStart', pid: m0.pid, session_id: sid2, source: 'compact' })).additionalContext)
  expect((await L.__mainEvent({ event: 'UserPromptSubmit', pid: m0.pid, session_id: sid2, prompt_id: 'p-128-5a' })).additionalContext).toBeUndefined()   // shown once
  await L.__mainEvent({ event: 'Stop', pid: m0.pid, session_id: sid2, prompt_id: 'p-128-5a', phase: 'final' })
  // a resumed main (its SessionStart context is lost on resume): the first prompt carries it
  expect((await L.__mainEvent({ event: 'SessionStart', pid: m0.pid, session_id: sid2, source: 'resume' })).additionalContext).toBeUndefined()
  const up = await L.__mainEvent({ event: 'UserPromptSubmit', pid: m0.pid, session_id: sid2, prompt_id: 'p-128-5b' })
  has(up.additionalContext)
  await L.__mainEvent({ event: 'Stop', pid: m0.pid, session_id: sid2, prompt_id: 'p-128-5b', phase: 'final' })
  // the mailbox cannot be read: one line, with what the router knows
  answer = { ok: false, why: 'BTCC 503' }
  const one = (await L.__mainEvent({ event: 'SessionStart', pid: m0.pid, session_id: sid2, source: 'clear' })).additionalContext.split('\n').filter((l: string) => l.includes('信箱'))
  expect(one.length).toBeGreaterThanOrEqual(1)
  expect(one.at(-1)).toMatch(/^〔信箱〕等你決定的件現在讀不到（BTCC 503）.*；用 mailbox_list 看。$/)
  process.env.LANES_MAILBOX_READ_MS = '300'
  L.__setMailWaiting(() => new Promise(() => {}))                                                     // no answer at all
  const slow = (await L.__mainEvent({ event: 'SessionStart', pid: m0.pid, session_id: sid2, source: 'clear' })).additionalContext
  expect(slow).toContain('〔信箱〕等你決定的件現在讀不到（0 秒內沒有回應）')
  delete process.env.LANES_MAILBOX_READ_MS
  answer = { ok: true, items: [] }; L.__setMailWaiting(async () => answer)
  expect((await L.__mainEvent({ event: 'SessionStart', pid: m0.pid, session_id: sid2, source: 'clear' })).additionalContext).toContain('〔信箱〕現在沒有等你決定的件。')
  // the agent-inbox daemon's route
  const I = await import('./lanes.ts?wo128-inbox') as typeof import('./lanes.ts')
  I.lanesInit({ role: 'inbox', agent: 'adam', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => true,
    mailWaiting: async () => ({ ok: true, items }) } as any)
  const srv = createServer(async (req, res) => { if (!(await I.handleLanesHttp(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res))) res.writeHead(404).end() })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  try {
    const j = await (await fetch(`http://127.0.0.1:${(srv.address() as any).port}/lanes/mail-waiting`, { method: 'POST', body: '{}', headers: { Authorization: 'Bearer x' } })).json()
    expect(j).toEqual({ ok: true, items })
  } finally { srv.close() }
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain("const r = await btccMail('GET', `/api/mesh/mail/due?within=${7 * 86400}`).catch(() => null)")
  L.__setMailWaiting(null)
  await m0.kill()
}, 30000)

// ------------------------------------------------------------------ 6: open-handoffs.md
test('WO-128 #6: open-handoffs.md lists no cards (can wait or not, a lane item or a mail-lane card); Joey\'s unfinished message to the main and a lane\'s hand-over are still listed', async () => {
  const a = await asked('要不要延後部署？')                                                              // can wait
  const b = await asked('部署壞了，回滾嗎？', { urgent_because: '部署壞了，讀者看到 500' })             // cannot wait
  const w = await start(reminder())
  await call(w, 'mailbox_open', { id: 8811 })
  expect(await call(w, 'mailbox_card', { id: 8811, card: { decide: '答不答應 Eve 週五交規格', recommend: '答應' } })).toContain('It can wait')
  await call(w, 'receipt', { outcome: 'done', happened: '1 封', did: '附卡', promised: '無', needs_main: '#8811' })
  await end(w)
  const h = await start(peer('幫我查 ticket 88 為什麼卡住'))
  await call(h, 'handoff_main', { text: 'ticket 88 要主線看' })
  await end(h)
  const j = joey('今天的部署延後了嗎？')
  await L.routeEvent(j)
  const f = handoffs()
  expect(f).toContain(`- ${j.id}｜來自 joey｜`)                                                        // Joey's own message, unfinished
  expect(f).toContain(`- ${h.id}｜來自 eve｜${ob(h.id, 'main').handoff}｜ticket 88 要主線看`)           // a lane's hand-over
  for (const x of [a.r.id, b.r.id, w.id]) expect(f).not.toContain(x)
  for (const m of [a.m, b.m, 8811]) expect(f).not.toContain(`#${m}`)
  expect(f).not.toContain('等你決定')
  settle(a.r.id, b.r.id, w.id, h.id, j.id)
  expect(handoffs()).toContain('（沒有）')
}, 40000)

// ------------------------------------------------------------------ the mail lane, and a lane that finds it cannot wait after all
// 1.41.0 final (Chiron on the ticket, 2026-11-24 13:00Z, 二): a mail-lane card with urgent_because wakes the main by itself (it no longer asks for handoff_main);
// handoff_main stays for 「這一趟自己出了狀況、要整件交回」 (after a card that can wait: wakes the matter; after one that cannot: one more item of its hand-over)
test('WO-128: the mail lane\'s card that can wait needs no hand-over (the lane stop does not ask; its line to Joey is the decision run\'s); one with urgent_because wakes the main by itself (no handoff_main asked; urgent_handoff); handoff_main after either still reaches the main; the 300 s count starts at the wake', async () => {
  const k = sent.length, w0 = wakes().length
  const w = await start(reminder())
  await call(w, 'mailbox_open', { id: 8821 })
  expect(await call(w, 'mailbox_card', { id: 8821, card: { decide: '要不要回 Eve 說週五交', recommend: '回好' } })).toContain('It can wait')
  expect(await call(w, 'notify_joey', { outcome: 'normal', text: '讀了 1 封' })).toContain('waits on the main\'s decision in its mailbox')
  expect(L.laneStop(w.tok)).toBeNull()                                                                 // nothing owed by the lane, no card to hand over
  await call(w, 'receipt', { outcome: 'done', happened: '1 封', did: '附卡', promised: '無', needs_main: '#8821' })
  expect(await end(w)).toMatchObject({ card_urgency: 'defer' })
  expect(itemsOf(w.id)).toEqual([]); expect(sent.slice(k)).toEqual([])
  // another run: a card that can wait, then one that cannot: the system wakes the main with the urgent card; the lane stop asks nothing
  const w2 = await start(reminder())
  await call(w2, 'mailbox_open', { id: 8822 }); await call(w2, 'mailbox_open', { id: 8823 })
  await call(w2, 'mailbox_card', { id: 8822, card: { decide: '8822 要不要答應', recommend: '答應' } })
  expect(await call(w2, 'mailbox_card', { id: 8823, card: { decide: '8823 要不要退款', recommend: '退' }, urgent_because: '客戶今天中午前要答覆' })).toContain('It cannot wait: the main is woken now with this card')
  expect(L.laneStop(w2.tok)).toBeNull()                                                                // no handoff_main asked for
  const o = ob(w2.id, 'main')
  expect(o).toMatchObject({ state: 'open', defer: true, woke: 'urgent', card: true }); expect(o.item).toBeTruthy(); expect(o.due_at).toBeGreaterThan(Date.now() + 290_000)
  const c = contentOf(itemsOf(w2.id).at(-1)!.notif)
  expect(c).toContain(`〔要你決定｜${o.handoff}｜信箱 #8823〕`); expect(c).toContain(`等不起（${w2.lane} 寫的）：客戶今天中午前要答覆`); expect(c).toContain('要你決定：8823 要不要退款')
  expect(c).not.toContain('8822')
  // the run itself went wrong: handoff_main is one more item of the same hand-over (not refused as handed already)
  expect(await call(w2, 'handoff_main', { text: '#8824 打不開（mailbox_open 回 500），請主線看' })).toContain('your text goes to it with the hand-over its card already woke it for')
  expect(itemsOf(w2.id).length).toBe(2); expect(ob(w2.id, 'main').item).toBe(itemsOf(w2.id).at(-1)!.id)
  expect(contentOf(itemsOf(w2.id).at(-1)!.notif)).toContain('#8824 打不開')
  await call(w2, 'receipt', { outcome: 'done', happened: '3 封', did: '附卡', promised: '無', needs_main: '#8823、#8824' })
  expect(await end(w2)).toMatchObject({ card_urgency: ['defer', 'urgent'] })
  // a third run: a card that can wait, then handoff_main (it cannot wait after all): the matter is woken
  const w3 = await start(reminder())
  await call(w3, 'mailbox_open', { id: 8825 })
  await call(w3, 'mailbox_card', { id: 8825, card: { decide: '8825 要不要答應', recommend: '答應' } })
  expect(await call(w3, 'handoff_main', { text: '#8825 寄件人說今天中午前要答覆' })).toContain('it is woken now')
  expect(ob(w3.id, 'main')).toMatchObject({ state: 'open', defer: true, woke: 'urgent' })
  await call(w3, 'receipt', { outcome: 'done', happened: '1 封', did: '附卡、交主線', promised: '無', needs_main: '#8825' })
  await end(w3)
  L.dueTick(o.due_at + 1); await sleep(20)                                                             // no main: 300 s after the wake, one push as for any hand-over
  // (WO-201: the main record of an earlier test is still idle here (gen of a /clear session), so the main can act: the push stands)
  expect(sent.slice(k).filter(s => s.text.includes('原本交給主線處理') && s.text.includes('#8823')).length).toBe(1)
  const m0 = await mainUp()
  expect(await until(() => wakes().length > w0)).toBe(true)
  expect(wakes().slice(w0)[0]).toMatchObject({ cause: 'urgent_handoff', event: w2.id })
  await m0.kill()
  settle(w.id, w2.id, w3.id)
}, 40000)

// ------------------------------------------------------------------ 5 (words), 10: the switch
test('WO-128 item 5: the words, verbatim: the boundary card\'s line replaced (10 lines, card_hash unchanged; the mail card\'s changes with the 13:00Z line 3); the main\'s rule right after the decision card\'s; both tools take urgent_because (not sent to BTCC)', () => {
  const card = B.boundaryDefault('adam')
  expect(card.length).toBe(12)                                                                     // 1.41.0: WO-132 (1.40.0) put its production line right after this one; 1.46.0: WO-144 its 「判斷之前」 line right before it
  expect(card[7]).toBe('要主線決定的那一步：等得起就用 decide_later 放進主線的信箱，不叫醒它；等不起才叫醒，寫出什麼會壞、誰在等。沒把握：當它等得起，不叫醒，也不猜著做完。')
  expect(card[8]).toBe(B.boundaryProdLine('adam'))                                                 // 1.41.1 (WO-137 乙): its words
  expect(card.join('\n')).not.toContain('沒把握：交給主線，不猜著做完。')
  const ctx = mainContext('adam', 'sid').split('\n')
  // 1.41.1 (WO-137 甲 item 7): with the batch wake on (default) the rule is the ticket's new words; LANES_DEFER_MAX_WAIT_S=0: 1.41.0's
  expect(ctx[ctx.indexOf(B.decisionMainRule()) + 1]).toBe('- 等得起的事會併成一批告訴你：你每次醒來，摘要會列「信箱有幾件等你決定」；你一直沒醒的話，最晚 45 分鐘會為它們叫你一次。快到期的那一件會再單獨叫你。')
  process.env.LANES_DEFER_MAX_WAIT_S = '0'
  try { const c0 = mainContext('adam', 'sid').split('\n'); expect(c0[c0.indexOf(B.decisionMainRule()) + 1]).toBe('- 等得起的事不會單獨叫醒你：你每次醒來，摘要會列「信箱有幾件等你決定」，一起處理；快到期的那一件才會單獨叫你。') }
  finally { delete process.env.LANES_DEFER_MAX_WAIT_S }
  const dl = L.laneToolsFor('reflex').find((t: any) => t.name === 'decide_later'), mc = L.laneToolsFor('mail').find((t: any) => t.name === 'mailbox_card')
  expect(Object.keys(dl.inputSchema.properties)).toEqual(['title', 'card', 'deadline', 'urgent_because'])
  expect(Object.keys(mc.inputSchema.properties)).toEqual(['id', 'card', 'urgent_because'])
  expect(dl.description).toBe(LANE_DECIDE_LATER_TOOL.description); expect(mc.description).toBe(MAILBOX_CARD_TOOL.description)
  expect(dl.inputSchema.required).toEqual(['title', 'card'])
  const h = Object.fromEntries((['reflex', 'mail', 'worker'] as const).map(k => [k, L.cardHash(k)]))
  process.env.LANES_DEFER_DECISIONS = '0'
  // 1.41.0 final: the mail lane's line 3 is Chiron's 13:00Z words with the switch on, 1.38.3's with it off: the mail card's hash differs (a resumed mail lane
  // gets the new card once); the others do not
  try { for (const k of ['reflex', 'worker'] as const) expect(L.cardHash(k)).toBe(h[k]); expect(L.cardHash('mail')).not.toBe(h.mail) } finally { delete process.env.LANES_DEFER_DECISIONS }
})

test('WO-128 #10: LANES_DEFER_DECISIONS=0 = 1.38: no urgent_because, the old card line, no main rule; every card wakes the main; no mailbox block in the digest or the context; open-handoffs lists the card; mail_due is information; no main_wake row, no card_urgency', async () => {
  const onCtx = mainContext('adam', 'sid'), onRule = B.deferMainRule(), onCard = B.boundaryDefault('adam'), onTools = Object.fromEntries((['reflex', 'mail'] as const).map(k => [k, L.laneToolsFor(k)]))
  L.__setMailWaiting(async () => ({ ok: true, items: [{ id: 1, title: 't', decide: 'd', deadline: hourOut() }] }))
  process.env.LANES_DEFER_DECISIONS = '0'
  try {
    expect(mainContext('adam', 'sid')).toBe(onCtx.replace(`\n${onRule}`, ''))
    expect(B.boundaryDefault('adam')).toEqual(onCard.map(l => l === B.BOUNDARY_DEFER_LINE ? '沒把握：交給主線，不猜著做完。' : l))
    const strip = (t: any) => ({ ...t, inputSchema: { ...t.inputSchema, properties: Object.fromEntries(Object.entries(t.inputSchema.properties).filter(([k]) => k !== 'urgent_because')) } })
    expect(L.laneToolsFor('reflex')).toEqual(onTools.reflex.map(strip)); expect(L.laneToolsFor('mail')).toEqual(onTools.mail.map(strip))
    const m0 = await mainUp()
    expect((await L.__mainEvent({ event: 'SessionStart', pid: m0.pid, session_id: m0.sid, source: 'startup' })).additionalContext).not.toContain('信箱有')
    const w0 = wakes().length, o0 = offers.length
    const a = await asked('要重啟嗎？（開關關著）', { urgent_because: '' })
    expect(a.out).toContain('The main was woken with your card')
    expect(await until(() => offers.length > o0)).toBe(true)
    expect(ob(a.r.id, 'main').defer).toBeUndefined(); expect(ob(a.r.id, 'main').woke).toBeUndefined(); expect(ob(a.r.id, 'main').card).toBeUndefined()
    expect(a.exit.card_urgency).toBeUndefined()
    expect(handoffs()).toContain(`信箱 #${a.m} 等你決定（mailbox_decide）`)
    expect(L.__digest()?.text ?? '').not.toContain('信箱有')
    expect((await L.routeEvent(due(a.m))).rule).toBe('mail-due')
    expect(wakes().length).toBe(w0)
    const row = jsonl(join(dir, 'ledger.jsonl')).find(x => x.event === a.r.id && x.refs?.decide_later === a.m)
    expect(row.refs.urgency).toBeUndefined(); expect(row.text).not.toContain('等得起')
    await m0.kill()
    settle(a.r.id)
  } finally { delete process.env.LANES_DEFER_DECISIONS; L.__setMailWaiting(null) }
}, 40000)

// ------------------------------------------------------------------ 7: nothing handled after its deadline
test('WO-128 #7: every card decided in these tests was decided before its deadline (0 handled late)', () => {
  const late: string[] = []
  for (const e of E().rows(r => Array.isArray(r.waits))) for (const w of e.waits as any[]) if (w.decided && w.deadline && Date.parse(w.decided.at) > Date.parse(w.deadline)) late.push(`#${w.mail_id}`)
  expect(E().rows(r => Array.isArray(r.waits)).flatMap(e => (e.waits as any[]).filter(w => w.decided)).length).toBeGreaterThanOrEqual(5)
  expect(late).toEqual([])
})
