// telegram-http 1.38.3 (board WO-131, Chiron's measurements 11-24 06:21Z; Chiron mail #11046 and #11059 item 1): the mail lane renews its conversation.
// What happened: the mail lane is one lane and one thread per agent, renewed only when closed or idle > 24 h; every resumed run after the cache expired
// wrote the whole conversation into the cache again, so the thread reached THREAD_BUDGET (1,000,000 fresh tokens) and startRun answered every later event
// 「…不再開車道處理，升級主線」. sonn.mail.1: exit reason=budget at 11-24 03:07:05Z (r15: 1 call, 110,465 fresh, thread 1,001,825); its next six reminders
// (03:08:04Z, 04:08:45Z, 05:09:26Z, 06:10:08Z, 07:11:01Z, 07:13:04Z) were each refused before the run (journal: exited reason=budget 「thread budget spent
// before the run」, then wake no_wake 「the event owes nothing more: recorded only」): nothing reached the main but six 「已結束」 digest lines, the mailbox went
// 3 → 7 unread, and the main closed the lane by hand at 07:16:47Z. chiron.mail.1.r17 (a decision's run) was cut at 1,000,338 after append_file,
// mailbox_check, notify_joey and receipt: its exit row said decision_outcome null.
// The lane process is a stand-in: it records its argv, prints the assistant messages (usage, tool calls) the test hands it, and ends when told; the
// mailbox is a stand-in that answers as BTCC does through fleet-mail.ts.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, mkdirSync, renameSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { decisionEvent } from './mail-events.ts'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?wo131') as typeof import('./lanes.ts')
const B = await import('./lanes-boundary.ts')

const ws = mkdtempSync(join(tmpdir(), 'lanes-wo131-ws-'))
const dir = join(ws, '.lanes'); mkdirSync(dir)
const tmp = mkdtempSync(join(tmpdir(), 'lanes-wo131-'))
mkdirSync(join(tmp, 'tr'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const ARGV = join(tmp, 'argv.jsonl'), bin = join(tmp, 'lane.py')
// the lane process: records its argv; prints each assistant message the test drops in use-<lane id> (usage, tool calls); ends on go-<lane id>.
// A SIGTERM (the daemon's budget stop) ends it as a signal, as claude's does.
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, time
lid = os.environ.get('LANE_ID', 'x')
with open('${ARGV}', 'a') as f: f.write(json.dumps({'lane': lid, 'argv': sys.argv[1:]}) + '\\n')
go = os.path.join('${tmp}', 'go-' + lid); use = os.path.join('${tmp}', 'use-' + lid)
t0 = time.time(); k = 0
while time.time() - t0 < 60 and not os.path.exists(go):
    if os.path.exists(use):
        try: u = json.load(open(use))
        except Exception: u = None
        os.remove(use)
        if u is not None:
            k += 1
            print(json.dumps({'type': 'assistant', 'message': {'id': 'msg-%s-%d' % (lid, k), 'usage': u.get('usage', {}), 'content': u.get('content', [])}}), flush=True)
    time.sleep(0.02)
try: os.remove(go)
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
// the mailbox, as BTCC answers through fleet-mail.ts; mailbox_card says whether the mail was sent no_reply (the agent-inbox daemon reads the mail record)
type Item = { id: number; lane: string; thread: string; ref: string | null; card: any; title: string; deadline: string }
const box = new Map<number, Item>()
const NO_REPLY = new Set([8921])
const mailCalls: any[] = []
L.__setMailTool(async b => {
  mailCalls.push(b)
  const a = b.args ?? {}
  if (b.name === 'mailbox_card') {
    const id = Number(a.id), deadline = '2026-11-25T01:00:00.000Z'
    box.set(id, { id, lane: b.lane, thread: a.thread, ref: null, card: { ...a.card, deadline }, title: `來信 ${id}`, deadline })
    return { text: `#${id} 附上決定卡了（決定期限 11-25 01:00Z）。`, isError: false, mail_id: id, deadline, ...(id >= 8920 ? { no_reply: NO_REPLY.has(id) } : {}) }
  }
  if (b.name === 'mailbox_check') return { text: `#${a.id} 勾掉了，不在清單上了。`, isError: false }
  if (b.name === 'mailbox_reply') return { text: '回信放進對方信箱了（#9901，不用回）。', isError: false, to: 'eve' }
  if (b.name === 'mailbox_open') return { text: `#${a.id} 來自 eve｜要你決定\n\n內容 ${a.id}`, isError: false }
  return { text: '3 封未讀', isError: false }
})
const sent: Array<{ text: string; silent: boolean }> = []
L.__setMeshSend(async () => ({ text: 'sent to eve', msgId: 77001, delivered: true }))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: ws, transcriptDir: join(tmp, 'tr'), httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve'],
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 9500 + sent.length }, joeyChatId: () => '1' } as any)
afterAll(() => { for (const f of [...Object.keys(L.__lanesState().lanes)]) try { writeFileSync(join(tmp, `go-${f}`), 'ok') } catch {}
  L.__setClaudeBin(restore); L.__setMailTool(null); L.__setMeshSend(null)
  for (const k of ['LANES_FLOOD_CONTROL', 'LANES_MAIL_ROTATE_TOKENS', 'LANES_MAIL_ROTATE_FRESH', 'LANES_DECISIONS']) delete process.env[k]
  rmSync(ws, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const jsonl = (p: string): any[] => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const ledger = () => jsonl(join(dir, 'ledger.jsonl'))
const lanesRows = () => jsonl(join(dir, 'lanes.jsonl'))
const exits = () => lanesRows().filter(x => x.kind === 'exit')
const runsOf = () => jsonl(ARGV)
const st = () => L.__lanesState()
const E = () => L.__events()
const handoffs = () => readFileSync(join(dir, 'open-handoffs.md'), 'utf8')
const mainItems = (ev: string) => L.__main().items(r => String(r.event) === ev && r.kind !== 'digest')
let n = 0
const reminder = () => { const text = '讀信箱（3 封未讀，最舊的等了 60 分鐘）：先用 mailbox_list（mcp__plugin_agent-inbox_agent-inbox__mailbox_list）看清單'
  return { id: `mesh-wo131-${++n}`, source: 'mesh', from: 'fleet-watchdog', verified: true, text, meta: { no_reply: 'true' }, no_reply: true, wake: 'mail', line: 'mail',
    notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }
type Run = { id: string; lane: string; tok: any; prompt: string; argv: string[] }
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
  return exits().filter(x => x.event === r.id && x.lane === r.lane).at(-1)
}
/** the lane process prints one assistant message (its usage, optionally tool calls); the daemon counts it against the thread budget */
async function emit(r: Run, fresh: number, tools: Array<{ name: string; input?: any }> = []): Promise<void> {
  const p = join(tmp, `use-${r.lane}.tmp`), use = join(tmp, `use-${r.lane}`)
  writeFileSync(p, JSON.stringify({ usage: { input_tokens: 0, cache_creation_input_tokens: fresh - 100, output_tokens: 100 },
    content: tools.map((t, i) => ({ type: 'tool_use', id: `tu-${r.lane}-${i}-${Date.now()}`, name: t.name, input: t.input ?? {} })) }))
  renameSync(p, use)
  expect(await until(() => !existsSync(use))).toBe(true)                                         // the lane process printed it
  await sleep(80)                                                                                  // and the daemon read it
}
/** the budget stops the run in the middle: its exit row */
async function cut(r: Run): Promise<any> {
  expect(await until(() => L.__runTok(r.lane)?.evId !== r.id, 8000)).toBe(true)
  await sleep(60)
  return exits().filter(x => x.event === r.id && x.lane === r.lane).at(-1)
}
const call = (r: Run, name: string, a: object) => L.callLaneTool(r.tok, name, a)
const thread = (lane: string) => st().threads[st().lanes[lane].thread]
/** the current mail lane is made due for renewal (its thread over LANES_MAIL_ROTATE_TOKENS): the next mail event opens a fresh one */
function wearOut(): void { const m = st().mail_lane; if (m) thread(m).fresh = 700_000 }
const decided = (id: number, decision: string, note: string | null = null) => {
  const it = box.get(id)!
  return decisionEvent({ id, title: it.title, decision, note, lane: it.lane, thread: it.thread, card: it.card, ref: it.ref }) as any
}
function settle(...ids: string[]): void {
  for (const id of ids) { if (!E().get(id)) continue; E().set(id, o => o.kind === 'main' && o.state === 'open', { state: 'met', by: 'test' }); E().set(id, o => ['joey', 'peer', 'receipt'].includes(o.kind) && (o.state === 'handed' || o.state === 'open'), { state: 'met', by: 'test' }) }
}
/** the mail lane cards mail `id` and hands it to the main; the run ends */
async function carded(id: number): Promise<Run> {
  const w = await start(reminder())
  await call(w, 'mailbox_open', { id })
  expect(await call(w, 'mailbox_card', { id, card: { decide: `${id} 答不答應 Eve`, recommend: '答應', basis: '它週五要', then: `回信 ${id}` } })).toContain('附上決定卡')
  expect(await call(w, 'handoff_main', { text: `#${id} Eve 要週五交規格，要主線決定` })).toContain('handed to the main')
  await end(w)
  settle(w.id)
  return w
}

// ------------------------------------------------------------------ A: the renewal
test('WO-131 A, replay of sonn.mail.1 after 03:07Z: a mail lane whose thread is over the budget is renewed by the next reminder: a fresh mail lane with the old thread\'s ledger summary; no 「升級主線」, nothing for the main', async () => {
  const w = await start(reminder())
  await call(w, 'mailbox_list', {})
  await call(w, 'receipt', { outcome: 'nothing-to-do', happened: '讀信箱提醒', did: '清單 3 封，都是知會，勾掉', promised: '無', needs_main: '無' })
  await end(w)
  expect(w.lane).toBe('adam.mail.1')
  thread(w.lane).fresh = 1_001_825; st().lanes[w.lane].last_fresh = 110_465                       // sonn#t-0a911f after r15
  const ev = reminder(), before = runsOf().length
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ rule: 'wake-mail', target: 'lane', lane: 'adam.mail.2' })
  expect(st().lanes[w.lane]).toMatchObject({ status: 'closed', rotated: { where: 'event' } })
  expect(st().mail_lane).toBe('adam.mail.2')
  expect(lanesRows().filter(x => x.kind === 'mail_lane_rotated').at(-1)).toMatchObject({ lane: w.lane, where: 'event', to: 'adam.mail.2', thread_fresh: 1_001_825, last_fresh: 110_465 })
  const r = await runOf('adam.mail.2', before, ev.id)
  expect(r.argv).toContain('--session-id')                                                       // a new session: the current cards in its system prompt
  expect(r.prompt).toContain('# 上一條讀信線的帳本紀錄（那條線的對話用到上限，換成你這條新的，由你接手）')
  const summary = r.prompt.split('# 上一條讀信線的帳本紀錄')[1].split('〔車道資訊結束')[0]
  expect(summary).toContain('｜讀信線#1｜讀信箱提醒；清單 3 封，都是知會，勾掉｜來自 fleet-watchdog')                // the old thread's events, one line each
  expect(st().lanes['adam.mail.2'].thread).not.toBe(st().lanes[w.lane].thread)
  expect(ledger().some(x => x.event === ev.id && x.kind === 'stop')).toBe(false)                    // never refused for the budget
  expect(mainItems(ev.id)).toEqual([])
  await end(r)
  // the next reminder resumes the fresh lane (its summary was given once)
  const ev2 = reminder(), before2 = runsOf().length
  expect(await L.routeEvent(ev2)).toMatchObject({ lane: 'adam.mail.2', note: expect.stringContaining('resume') })
  const r2 = await runOf('adam.mail.2', before2, ev2.id)
  expect(r2.prompt).not.toContain('上一條讀信線的帳本紀錄')
  await end(r2)
}, 30000)

test('WO-131 A, the two thresholds: the thread at LANES_MAIL_ROTATE_TOKENS (600,000), or the last run at LANES_MAIL_ROTATE_FRESH (100,000) fresh tokens, measured from the run itself; 0 turns a rule off; the budget itself always renews', async () => {
  wearOut()
  let r = await start(reminder()); const lane = r.lane
  await emit(r, 40_000)                                                                                  // a run of 40,000 fresh tokens
  let x = await end(r)
  expect(x.tokens_fresh).toBe(40_000); expect(st().lanes[lane].last_fresh).toBe(40_000)
  thread(lane).fresh = 599_999
  r = await start(reminder()); expect(r.lane).toBe(lane)                                           // below both: resumed
  await emit(r, 100_000)
  x = await end(r)
  expect(x.tokens_fresh).toBe(100_000); expect(st().lanes[lane].last_fresh).toBe(100_000)
  thread(lane).fresh = 300_000                                                                     // the thread is fine; the last run was not
  process.env.LANES_MAIL_ROTATE_FRESH = '0'                                                        // that rule off: resumed
  r = await start(reminder()); expect(r.lane).toBe(lane)
  await emit(r, 100_000); await end(r)
  delete process.env.LANES_MAIL_ROTATE_FRESH
  r = await start(reminder())
  expect(r.lane).not.toBe(lane)
  expect(lanesRows().filter(x => x.kind === 'mail_lane_rotated').at(-1)).toMatchObject({ lane, where: 'event', why: expect.stringContaining('its last run used 100000 fresh tokens') })
  await end(r)
  const l2 = r.lane
  thread(l2).fresh = 600_000
  process.env.LANES_MAIL_ROTATE_TOKENS = '0'                                                       // that rule off: resumed
  r = await start(reminder()); expect(r.lane).toBe(l2); await end(r)
  thread(l2).fresh = 1_000_000                                                                     // the budget: renewed whatever the knobs say
  r = await start(reminder()); expect(r.lane).not.toBe(l2)
  expect(lanesRows().filter(x => x.kind === 'mail_lane_rotated').at(-1)).toMatchObject({ lane: l2, why: expect.stringContaining('the thread budget') })
  await end(r)
  delete process.env.LANES_MAIL_ROTATE_TOKENS
  thread(r.lane).fresh = 600_000
  const r3 = await start(reminder()); expect(r3.lane).not.toBe(r.lane)                             // at 600,000 exactly: renewed
  await end(r3)
}, 40000)

test('WO-131 A, a run the budget cuts before its closing call (sonn.mail.1.r15): its event runs once more on a fresh mail lane, told what the cut run did; a second cut ends as before (the exit rule)', async () => {
  wearOut()
  const r = await start(reminder()); const a = r.lane
  thread(a).fresh = 550_000                                                                       // below the renewal mark when it started
  await emit(r, 460_000, [{ name: 'mcp__lane__mailbox_list' }])                                          // 1,010,000 ≥ 1,000,000 in the run: SIGTERM
  const x = await cut(r)
  expect(x).toMatchObject({ reason: 'budget', requeued: 'fresh mail lane', tokens_fresh: 460_000 })
  expect(st().lanes[a]).toMatchObject({ status: 'closed', rotated: { where: 'cut' } })
  expect(ledger().filter(l => l.event === r.id && l.kind === 'stop').at(-1).text).toContain('這件事交給新的讀信線重跑一次')
  const moved = lanesRows().filter(l => l.kind === 'mail_event_moved' && l.event === r.id).at(-1)
  expect(moved).toMatchObject({ lane: a, cut: true })
  const b = moved.to
  const r2 = await runOf(b, 0, r.id)
  expect(r2.prompt).toContain(`〔上一趟（${a}）被對話線的 token 預算中止，這件事交給你重跑一次。它中止前做過的事（照順序）：〕`)
  expect(r2.prompt).toContain('1. lane:mailbox_list')
  expect(r2.prompt).toContain('做過的不要再做一次')
  expect(mainItems(r.id)).toEqual([])                                                             // never escalated for the budget
  expect(E().get(r.id)).toMatchObject({ owner: b, lane: b, moved_from: a })
  // the second cut: its run opened a mail (so it owes Joey a line); nothing more is re-run, the exit rule hands what it owes to the main, as before
  await call(r2, 'mailbox_open', { id: 7001 })
  thread(b).fresh = 950_000
  await emit(r2, 60_000)
  const x2 = await cut(r2)
  expect(x2.reason).toBe('budget'); expect(x2.requeued).toBeUndefined()
  expect(st().lanes[b].status).not.toBe('closed')
  expect(mainItems(r.id).length).toBe(1)
  settle(r.id)
}, 40000)

test('WO-131 A, replay of chiron.mail.1.r17: a decision\'s run cut by the budget AFTER it had done its work (mailbox_check, notify_joey, receipt): decision_outcome done, from its tool record; nothing re-run, nothing for the main', async () => {
  wearOut()
  await carded(8901)
  const before = runsOf().length
  const d = await L.routeEvent(decided(8901, 'as_recommended'))
  const dr = await runOf(d.lane!, before, 'mail-decision-8901')
  await call(dr, 'mailbox_reply', { id: 8901, body: '週五可以' })
  await call(dr, 'mailbox_check', { id: 8901 })
  await call(dr, 'notify_joey', { outcome: 'changed', text: '已回 Eve：週五可以' })
  await call(dr, 'receipt', { outcome: 'done', happened: '主線決定照建議', did: '回了 Eve、勾掉 #8901', promised: '無', needs_main: '無' })
  thread(dr.lane).fresh = 950_000                                                                  // chiron.mail.1 hit 1,000,338 in this run
  await emit(dr, 60_000, [{ name: 'mcp__lane__receipt' }])
  const x = await cut(dr)
  expect(x).toMatchObject({ reason: 'budget', decision: 'as_recommended', decision_mail_id: 8901, decision_outcome: 'done', decision_outcome_from: 'tools' })
  expect(x.requeued).toBeUndefined()
  expect(lanesRows().some(l => l.kind === 'mail_event_moved' && l.event === dr.id)).toBe(false)
  expect(mainItems(dr.id)).toEqual([])
  expect(E().openObs(dr.id)).toEqual([])
}, 30000)

test('WO-131 A, a decision\'s run cut by the budget before it finished: the decision is not lost: it runs once more on a fresh mail lane (the event block names the new thread), still owing Joey its line, which that run meets', async () => {
  wearOut()
  await carded(8902)
  const before = runsOf().length
  const d = await L.routeEvent(decided(8902, 'changed', '改成下週一'))
  const dr = await runOf(d.lane!, before, 'mail-decision-8902')
  expect(dr.prompt).toContain(`thread ${st().lanes[dr.lane].thread}]`)
  thread(dr.lane).fresh = 950_000
  await emit(dr, 60_000, [{ name: 'mcp__lane__mailbox_open', input: { id: 8902 } }])
  const x = await cut(dr)
  expect(x).toMatchObject({ reason: 'budget', decision_outcome: 'requeued', requeued: 'fresh mail lane' })
  const to = lanesRows().filter(l => l.kind === 'mail_event_moved' && l.event === dr.id).at(-1).to
  const r2 = await runOf(to, 0, dr.id)
  expect(r2.prompt).toContain('主線回了決定：改成：改成下週一。')
  expect(r2.prompt).toContain(`thread ${st().lanes[to].thread}]`)
  expect(r2.prompt).toContain('1. lane:mailbox_open')
  expect(E().openObs(dr.id).map(o => o.kind)).toEqual(['joey'])                                    // what the main had owed went to the decision; still owed
  await call(r2, 'mailbox_reply', { id: 8902, body: '改成下週一' }); await call(r2, 'mailbox_check', { id: 8902 })
  await call(r2, 'notify_joey', { outcome: 'changed', text: '已回 Eve：改成下週一' })
  const x2 = await end(r2)
  expect(x2).toMatchObject({ reason: 'normal', decision_outcome: 'done' })
  expect(E().openObs(dr.id)).toEqual([])
  expect(mainItems(dr.id)).toEqual([])
}, 30000)

test('WO-131 A, cards and open-handoffs survive the renewal; a decision that waits behind the old lane\'s running run is moved to the fresh lane when it starts (the existing rule for a mail_decision whose lane is gone)', async () => {
  wearOut()
  const w = await carded(8911)
  expect(handoffs()).toContain('信箱 #8911 等你決定')
  thread(w.lane).fresh = 700_000
  const g = await start(reminder())                                                               // renewed: a fresh lane
  expect(g.lane).not.toBe(w.lane)
  expect(handoffs()).toContain('信箱 #8911 等你決定')                                                // the card still waits on the asking event
  thread(g.lane).fresh = 700_000                                                                   // and this one is due too, but it is running
  const d = await L.routeEvent(decided(8911, 'as_recommended'))
  expect(d).toMatchObject({ rule: 'mail-decision', target: 'lane', lane: g.lane, note: expect.stringContaining('queued behind the running run') })
  await end(g)
  const moved = await until(() => lanesRows().some(l => l.kind === 'mail_event_moved' && l.event === 'mail-decision-8911'))
  expect(moved).toBe(true)
  const to = lanesRows().filter(l => l.kind === 'mail_event_moved' && l.event === 'mail-decision-8911').at(-1).to
  expect(st().lanes[g.lane]).toMatchObject({ status: 'closed', rotated: { where: 'start' } })
  const h = await runOf(to, 0, 'mail-decision-8911')
  expect(h.prompt).toContain('主線回了決定：照建議。')
  expect(h.prompt).toContain('要你決定：8911 答不答應 Eve')
  await call(h, 'mailbox_reply', { id: 8911, body: '答應' }); await call(h, 'mailbox_check', { id: 8911 })
  await call(h, 'notify_joey', { outcome: 'changed', text: '已回 Eve：答應' })
  await end(h)
  expect(handoffs()).not.toContain('#8911')
  expect(mainItems('mail-decision-8911')).toEqual([])
}, 40000)

test('WO-131 A, reflex lanes are unchanged: a reflex lane whose thread is past 600,000 is resumed on its thread, not renewed', async () => {
  const ev = { id: `mesh-wo131-${++n}`, source: 'mesh', from: 'eve', verified: true, text: 'api-gw 5xx 一直高？', meta: {}, line: 'call', notif: { method: 'notifications/claude/channel', params: { content: 'x', meta: {} } } } as any
  const r = await start(ev)
  await call(r, 'notify_joey', { outcome: 'normal', text: 'api-gw 正常' }); await call(r, 'reply_agent', { line: 'call', to: 'eve', reply_to: '1', text: '正常' })
  await end(r)
  thread(r.lane).fresh = 700_000; st().lanes[r.lane].last_fresh = 150_000
  const ev2 = { ...ev, id: `mesh-wo131-${++n}`, thread: st().lanes[r.lane].thread, text: '那 db 呢？' }
  const before = runsOf().length
  const d = await L.routeEvent(ev2)
  expect(d.lane).toBe(r.lane)
  const r2 = await runOf(r.lane, before, ev2.id)
  expect(r2.argv).toContain('--resume')
  await call(r2, 'notify_joey', { outcome: 'normal', text: 'db 正常' }); await call(r2, 'reply_agent', { line: 'call', to: 'eve', reply_to: '2', text: 'db 正常' })
  await end(r2)
  expect(st().lanes[r.lane].rotated).toBeUndefined()
}, 30000)

// ------------------------------------------------------------------ B: the words (Chiron mail #11046), verbatim
const MAIL_LINE_3 = '- 要主線的信（要代表 adam 答應或決定、要做不可逆的事、要主線手上的脈絡或工具）：在那封信上附決定卡（mailbox_card），五格：要 adam 決定什麼／期限／信裡的關鍵事實與出處（數字、檔案位置、它給的選項）／你的建議和根據（查不到根據就寫「沒有建議」）／主線說好之後你會做什麼。附完用 handoff_main 交回，一句話列出附了卡的 #id 和各要決定什麼，卡的內容不用再寫一次。那一封不要勾掉。主線用 mailbox_decide 回了決定，你會被叫起來照決定做完。整件只能主線自己做的（收不回的動作、要它這段對話才知道的事、工單驗收）：不附卡，用 handoff_main 把 #id、寄件人、期限、它要什麼、關鍵事實寫清楚交回。焦點卡上寫「交回主線」的類別，意思是由主線決定，不是不讓你讀：照樣打開、照樣整理。'
const BOUNDARY_STEP = '只把需要主線的那一步交出去：用 decide_later 開一張決定卡（同事的來信用 mailbox_card 附在那封信上），五格：要你決定什麼／期限／關鍵事實與出處／我的建議與根據（查不到根據就寫「沒有建議」）／你說好之後我會做什麼。整件只能主線自己做的才用 handoff_main。'
test('WO-131 B: the mail lane\'s line 3 and the boundary card\'s step, verbatim; the WO-127 sentence still follows; the mail card\'s hash changes (a resumed mail lane gets the new card once); LANES_DECISIONS=0 keeps the old words', async () => {
  const card = L.identityCard({ kind: 'mail' }).split('\n')
  expect(card).toContain(MAIL_LINE_3)
  expect(card.filter(l => l.startsWith('- 要主線的信')).length).toBe(1)
  const line = B.boundaryDefault('adam').find(l => l.startsWith('需要任何一樣：'))!
  expect(line).toBe('需要任何一樣：分的是「一步」，不是「一件」。你做得了的每一步都做完（讀、查、對數字、擬好回覆、備好指令），' + BOUNDARY_STEP + B.BOUNDARY_DECISION_SENTENCE)
  expect(B.boundaryDefault('adam').length).toBe(11)                                                   // WO-132 (1.40.0) added the production line
  // the 1.38.2 line, put back: another hash. A mail lane whose session got the old card gets the new one in its next run, once
  const old = '- 要主線的信（要代表 adam 答應或決定、要做不可逆的事、要主線手上的脈絡或工具）：用 handoff_main 交回，寫到主線不用再打開信就能決定：#id、寄件人、期限；它要 adam 決定或做什麼；信裡的關鍵事實（數字、檔案位置、它給的選項）；你的建議和根據（查不到根據就寫「沒有建議」）；你沒查的。那一封不要勾掉，主線處理完自己勾。焦點卡上寫「交回主線」的類別，意思是由主線決定，不是不讓你讀：照樣打開、照樣整理。'
  const was = L.__setKindLinesForTest((kind, lines) => kind === 'mail' ? lines.map(l => l === MAIL_LINE_3 ? old : l) : lines)
  const oldHash = L.cardHash('mail')
  L.__setKindLinesForTest(was)
  expect(L.cardHash('mail')).not.toBe(oldHash)
  const m = st().mail_lane!
  st().lanes[m].card_hash = oldHash
  const r = await start(reminder()); expect(r.lane).toBe(m)
  expect(r.prompt).toContain(L.CARD_UPDATED_HEAD); expect(r.prompt).toContain(MAIL_LINE_3)
  await end(r)
  const r2 = await start(reminder()); expect(r2.prompt).not.toContain(L.CARD_UPDATED_HEAD); await end(r2)
  process.env.LANES_DECISIONS = '0'
  try {
    expect(L.identityCard({ kind: 'mail' }).split('\n')).toContain(old)
    expect(B.boundaryDefault('adam').find(l => l.startsWith('需要任何一樣：'))).toBe('需要任何一樣：分的是「一步」，不是「一件」。你做得了的每一步都做完（讀、查、對數字、擬好回覆、備好指令），' + B.BOUNDARY_HANDOFF_STEP)
  } finally { delete process.env.LANES_DECISIONS }
}, 30000)

// ------------------------------------------------------------------ C: a mail sent no_reply (Chiron mail #11059 item 1)
test('WO-131 C: a decision on a card whose mail was sent no_reply says 「這封信標了不用回：不回信，勾掉」; otherwise the reply line as before; the agent-inbox daemon reads the flag from the mail record', async () => {
  wearOut()
  const w = await start(reminder())
  for (const id of [8921, 8922]) { await call(w, 'mailbox_open', { id }); await call(w, 'mailbox_card', { id, card: { decide: `${id} 要不要`, recommend: '要' } }) }
  await call(w, 'handoff_main', { text: '#8921、#8922 各要主線決定' })
  await end(w)
  settle(w.id)
  expect((E().get(w.id)!.waits as any[]).map(x => [x.mail_id, x.no_reply])).toEqual([[8921, true], [8922, false]])
  let before = runsOf().length
  let d = await L.routeEvent(decided(8921, 'as_recommended'))
  const a = await runOf(d.lane!, before, 'mail-decision-8921')
  expect(a.prompt).toContain('- 這封信標了不用回：不回信，勾掉（mailbox_check）。')
  expect(a.prompt).not.toContain('這封信照決定回信（mailbox_reply）')
  await call(a, 'mailbox_check', { id: 8921 }); await call(a, 'notify_joey', { outcome: 'changed', text: '#8921 照建議，勾掉' })
  await end(a)
  before = runsOf().length
  d = await L.routeEvent(decided(8922, 'as_recommended'))
  const b = await runOf(d.lane!, before, 'mail-decision-8922')
  expect(b.prompt).toContain('- 這封信照決定回信（mailbox_reply）、勾掉（mailbox_check）。')
  expect(b.prompt).not.toContain('標了不用回')
  await call(b, 'mailbox_reply', { id: 8922, body: '要' }); await call(b, 'mailbox_check', { id: 8922 }); await call(b, 'notify_joey', { outcome: 'changed', text: '#8922 回了' })
  await end(b)
  // the agent-inbox side: after BTCC's card answer, the mail record (GET by=lane: the card already made it lane_read) gives no_reply
  const srv = readFileSync(join(import.meta.dir, 'server.ts')).toString('latin1')
  expect(srv).toContain("btccMail('GET', `/api/mesh/mail/${j.id}?by=lane`)")
  expect(srv).toContain('...(noReply !== undefined ? { no_reply: noReply } : {})')
}, 30000)
