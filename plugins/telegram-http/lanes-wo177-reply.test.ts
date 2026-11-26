// telegram-http 1.58.5 (board WO-177, 六 last point; Chiron 02:22Z): a lane answered peer items that needed no answer (lab-relay's ledger: 「收到…已讀…
// 依指示未做任何動作」 mails, #200206), and one answer went out twice 2 s apart at hop 2 and hop 3. Played here:
// - the receipt closes the lane's account: an answer to the sender it has not sent by then is waived (the notice, the test, 「讀到就好」); still owed: the
//   answer it tried to send and could not deliver, and every answer when its receipt says failed (it could not do it); a run with no receipt hands over
//   as before; a send after the receipt is an answer like any other;
// - the event header says when the sender marked the item no_reply (a fact line); such an item opens no answer at all;
// - lab-relay.reflex.21 at 01:29:44Z / 01:29:46Z: the hop is advanced by a delivered call only, and the ledger says an attempt did not go through.
// The lane is a script that waits for the test to say how its run ends; its tool calls are made through the run's own token. No model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?wo177-reply-test') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo177r-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
const GO = join(dir, 'go')
const bin = join(dir, 'lane.py')
// the run's prompt (argv after -p) is kept per run, for the event header
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys, time
a = sys.argv
p = a[a.index('-p') + 1] if '-p' in a else ''
open('${dir}/prompt-%d.txt' % int(time.time() * 1000), 'w').write(p)
t0 = time.time()
mode = 'ok'
while time.time() - t0 < 30:
    if os.path.exists('${GO}'):
        mode = open('${GO}').read().strip(); os.remove('${GO}'); break
    time.sleep(0.02)
if mode == 'turns':
    print(json.dumps({'type': 'result', 'subtype': 'error_max_turns', 'is_error': True, 'terminal_reason': 'max_turns'}), flush=True); sys.exit(1)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
L.__setRetryBackoff(20)
const sent: string[] = [], mesh: any[] = []
let refuse: RegExp | null = null                    // a text the inbox daemon cannot deliver (Onsen's HTTP 400 at 01:29:44Z)
L.__setMeshSend(async b => {
  mesh.push(b)
  if (refuse && refuse.test(String(b.text ?? ''))) return { text: `send to ${b.to} FAILED (Onsen: HTTP 400 unknown field turn_id in payload) — message NOT delivered`, delivered: false }
  return { text: `sent to ${b.to}`, msgId: 80000 + mesh.length, delivered: true }
})
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve', 'sonn'],
  sendBot: async (_c: string, text: string) => { sent.push(text); return 9000 + sent.length }, joeyChatId: () => '1', createTopic: async () => 4400 } as any)
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; L.__setClaudeBin(restore); L.__setRetryBackoff(5000); L.__setMeshSend(null); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const rows = (n = 'ledger.jsonl'): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const E = () => L.__events()
const obs = (id: string): any[] => E().get(id)?.obligations ?? []
const answer = (id: string) => obs(id).find(o => o.kind === 'peer' && o.level === 'answer')
let n = 0
const mk = (from: string, text: string, extra: object = {}) => ({ id: `mesh-w177r-${++n}`, source: 'mesh', from, verified: true, text, btcc_msg_id: String(177000 + n), meta: {},
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } }, ...extra } as any)
async function start(ev: any): Promise<{ id: string; lane: string; tok: any }> {
  const d = await L.routeEvent(ev)
  expect(d.target).toBe('lane')
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  return { id: ev.id, lane: d.lane!, tok: L.__runTok(d.lane!)! }
}
async function end(lane: string, mode = 'ok'): Promise<void> {
  writeFileSync(GO, mode)
  expect(await until(() => !L.__runTok(lane))).toBe(true)
  await sleep(40)
}
const call = (tok: any, name: string, a: object) => L.callLaneTool(tok, name, a)
const handed = (id: string) => L.__main().items(r => r.kind === 'handoff' && r.event === id)
const replies = (lane: string) => rows().filter(r => r.lane === lane && r.kind === 'action' && String(r.text).startsWith('reply_agent'))
/** the prompt of the run on event `id` (the fake claude writes it when it starts) */
async function promptOf(id: string): Promise<string> {
  const find = (): string => { for (const f of require('fs').readdirSync(dir).filter((f: string) => f.startsWith('prompt-'))) { const t = readFileSync(join(dir, f), 'utf8'); if (t.includes(`[車道事件 ${id}｜`)) return t } return '' }
  await until(() => !!find(), 3000)
  return find()
}

test('acceptance 11 b: a peer item with no flag that needs nothing back (「讀到就好」): notify_joey + receipt, no reply_agent: the answer is waived by the receipt, the stop asks nothing, nobody is handed anything, the event closes', async () => {
  const k = mesh.length
  const p = await start(mk('sonn', 'WO-177 驗收 11b：測試件，讀到就好。', { line: 'call' }))
  expect(answer(p.id)).toMatchObject({ to: 'sonn', state: 'open' })                     // the router cannot read 「讀到就好」: an answer is opened as before
  expect(await promptOf(p.id)).not.toContain('no_reply')
  expect(await call(p.tok, 'notify_joey', { outcome: 'normal', text: 'sonn 的測試件 11b，讀到了' })).toContain('sent to Joey')
  const r = await call(p.tok, 'receipt', { outcome: 'done', happened: 'sonn 的測試件 11b', did: '讀了，沒有要交給它的東西', promised: '無', needs_main: '無' })
  expect(r).toContain('nothing else is open for this event')                          // the receipt no longer says 「still open: an answer to sonn」
  expect(answer(p.id)).toMatchObject({ state: 'waived', by: 'receipt' })
  expect(L.laneStop(p.tok)).toBeNull()
  await end(p.lane)
  expect(handed(p.id).length).toBe(0)
  expect(E().get(p.id)!.state).toBe('closed')
  expect(mesh.length).toBe(k)                                                        // nothing went to sonn: no reply_agent, no router interim
  expect(replies(p.lane).length).toBe(0)
  expect(rows().filter(x => x.event === p.id && x.kind === 'receipt').length).toBe(1)
})

test('acceptance 11 c: a peer item that asks for a number: one reply_agent with the result, met; the receipt waives nothing; one send, closed', async () => {
  const k = mesh.length
  const p = await start(mk('sonn', 'WO-177 驗收 11c：請算 17×23，把結果回給我。', { line: 'call' }))
  expect(await call(p.tok, 'reply_agent', { to: 'sonn', text: '17×23＝391' })).toBe('sent to sonn')
  expect(answer(p.id)).toMatchObject({ state: 'met', by: 'reply_agent' })
  await call(p.tok, 'notify_joey', { outcome: 'normal', text: 'sonn 要 17×23，回了 391' })
  await call(p.tok, 'receipt', { outcome: 'done', happened: 'sonn 要 17×23', did: '回 391', promised: '無', needs_main: '無' })
  expect(answer(p.id)).toMatchObject({ state: 'met', by: 'reply_agent' })
  await end(p.lane)
  expect(mesh.length).toBe(k + 1); expect(mesh.at(-1)).toMatchObject({ to: 'sonn', text: '17×23＝391', line: 'call', no_reply: true })
  expect(replies(p.lane).length).toBe(1)
  expect(handed(p.id).length).toBe(0); expect(E().get(p.id)!.state).toBe('closed')
})

test('acceptance 11 a: a no_reply item opens no answer, and its event header says the sender marked it (a fact line); notify_joey + receipt close it', async () => {
  // the fresh no_reply call is recorded only by the router (rule mesh-no-reply / wake peer-no-reply: no session opened); one on a thread a lane owns goes
  // to that lane (wake rule owner). Played here as the run the router queues on the lane that owns the thread.
  const b = await start(mk('sonn', 'WO-177 驗收 11a 前置：開一條線', { line: 'call' }))
  await call(b.tok, 'notify_joey', { outcome: 'normal', text: '前置' }); await call(b.tok, 'receipt', { outcome: 'done', happened: '前置', did: '前置', promised: '無', needs_main: '無' })
  await end(b.lane)
  const k = mesh.length
  const ev = mk('sonn', 'WO-177 驗收 11a：知會，lab 的 1.58.5 上了。', { line: 'call', no_reply: true, thread: L.__lanesState().lanes[b.lane].thread })
  L.__putQueue({ ev, lane: b.lane, state: 'queued', attempts: 0, priority: 1, enqueued: '' })
  expect(await until(() => !!L.__runTok(b.lane))).toBe(true)
  const p = { id: ev.id, lane: b.lane, tok: L.__runTok(b.lane)! }
  expect(answer(p.id)).toBeUndefined()
  expect(await promptOf(p.id)).toContain('｜寄件者標了不用回（no_reply）｜')
  await call(p.tok, 'notify_joey', { outcome: 'normal', text: 'sonn 知會 1.58.5 上了' })
  await call(p.tok, 'receipt', { outcome: 'done', happened: 'sonn 知會', did: '記下', promised: '無', needs_main: '無' })
  await end(p.lane)
  expect(mesh.length).toBe(k); expect(handed(p.id).length).toBe(0); expect(E().get(p.id)!.state).toBe('closed')
})

test('「做不了」: a receipt with outcome failed waives nothing: the stop names the answer once; a run ending so hands it to the main (the sender is owed word of it)', async () => {
  const p = await start(mk('eve', '幫我把 mock-api 的 log_level 改成 debug，改好回我', { line: 'call' }))
  await call(p.tok, 'notify_joey', { outcome: 'failed', text: 'Eve 要改 log_level，沒有權限改' })
  expect(await call(p.tok, 'receipt', { outcome: 'failed', happened: 'Eve 要改 log_level', did: '沒權限，沒改', promised: '無', needs_main: '無' })).toContain('still open: an answer to eve (reply_agent)')
  expect(answer(p.id)).toMatchObject({ state: 'open' })
  expect(L.laneStop(p.tok)).toContain('an answer to eve (reply_agent)')
  await end(p.lane)
  expect(handed(p.id).length).toBe(1)
  expect(String(handed(p.id)[0].notif.params.content)).toContain('eve 還在等回答')
})

test('an answer the lane tried to send and could not deliver stays owed through the receipt (it had a result): handed to the main at the end', async () => {
  refuse = /^5xx：/
  const p = await start(mk('eve', '上週 5xx 有幾次？', { line: 'call' }))
  const out = await call(p.tok, 'reply_agent', { to: 'eve', text: '5xx：上週 14 次' })
  expect(out).toContain('NOT delivered')
  refuse = null
  expect(answer(p.id)).toMatchObject({ state: 'open' }); expect(answer(p.id).failed).toBeTruthy()
  await call(p.tok, 'notify_joey', { outcome: 'normal', text: 'Eve 問 5xx，14 次，回覆沒送出' })
  await call(p.tok, 'receipt', { outcome: 'done', happened: 'Eve 問 5xx', did: '查到 14 次，回覆沒送出', promised: '無', needs_main: '無' })
  expect(answer(p.id)).toMatchObject({ state: 'open' })
  await end(p.lane)
  expect(handed(p.id).length).toBe(1)
})

test('a run that ends without its receipt closed no account: an open answer is handed to the main as before (the exit rule)', async () => {
  const p = await start(mk('eve', '下週的維護時段？', { line: 'call' }))
  await call(p.tok, 'notify_joey', { outcome: 'normal', text: 'Eve 問維護時段' })
  await end(p.lane, 'turns')
  expect(handed(p.id).length).toBe(1)
  expect(String(handed(p.id)[0].notif.params.content)).toContain('eve 還在等回答')
})

test('a send after the receipt is an answer like any other: the waiver is undone, met on delivery; if that send fails the answer is owed again', async () => {
  const p = await start(mk('eve', '你那邊 btcc-api 是哪一版？', { line: 'call' }))
  await call(p.tok, 'notify_joey', { outcome: 'normal', text: 'Eve 問版本' })
  await call(p.tok, 'receipt', { outcome: 'done', happened: 'Eve 問版本', did: '還沒查', promised: '無', needs_main: '無' })
  expect(answer(p.id).state).toBe('waived')
  refuse = /^v/
  expect(await call(p.tok, 'reply_agent', { to: 'eve', text: 'v1.42' })).toContain('NOT delivered')
  expect(answer(p.id)).toMatchObject({ state: 'open' })                               // it tried: owed again, not back to waived
  refuse = null
  expect(await call(p.tok, 'reply_agent', { to: 'eve', text: 'v1.42' })).toBe('sent to eve')
  expect(answer(p.id)).toMatchObject({ state: 'met', by: 'reply_agent' })
  await end(p.lane)
  expect(handed(p.id).length).toBe(0); expect(E().get(p.id)!.state).toBe('closed')
})

test('the main\'s activity list says what a waived answer is (not 「還沒回」)', async () => {
  const p = await start(mk('eve', '測試件：讀到就好', { line: 'call' }))
  await call(p.tok, 'notify_joey', { outcome: 'normal', text: 'Eve 測試件' })
  await call(p.tok, 'receipt', { outcome: 'nothing-to-do', happened: 'Eve 測試件', did: '讀了', promised: '無', needs_main: '無' })
  await end(p.lane)
  const d = L.activityList(undefined)
  expect(d).toContain('沒回 eve（車道結帳時判這件不用回）')
})

test('lab-relay.reflex.21, 01:29:44Z / 01:29:46Z: a call that is not delivered uses no hop; the retry of the same text goes as the same hop, once delivered the hop counts; the ledger says the first did not go through', async () => {
  const p = await start(mk('sonn', 'WO-172 測試 3：用 notify_joey 告訴 Joey 一句「WO-172 分身收到呼叫」，然後結束。', { line: 'call', hop: 1, thread: undefined }))
  const th = L.__lanesState().threads[L.__lanesState().lanes[p.lane].thread]
  const before = th.hops
  refuse = /^WO-172 測試 3 結果/
  const text = 'WO-172 測試 3 結果：已用 notify_joey 告訴 Joey「WO-172 分身收到呼叫」（message_id 725）。'
  expect(await call(p.tok, 'reply_agent', { line: 'call', to: 'sonn', reply_to: p.tok.evId.replace(/\D/g, ''), text })).toContain('NOT delivered')
  expect(th.hops).toBe(before)                                                                // a refused send used no hop
  const h1 = mesh.at(-1).hop
  refuse = null
  expect(await call(p.tok, 'reply_agent', { line: 'call', to: 'sonn', reply_to: p.tok.evId.replace(/\D/g, ''), text })).toBe('sent to sonn')
  expect(mesh.at(-1).hop).toBe(h1)                                                            // the retry is the same hop, not the next
  const rs = replies(p.lane)
  expect(rs.length).toBe(2)
  expect(rs[0].text).toContain(`（hop ${h1}，沒送出）`); expect(rs[0].refs.delivered).toBe(false)
  expect(rs[1].text).toContain(`（hop ${h1}）`); expect(rs[1].refs.delivered).toBe(true)
  expect(answer(p.id)).toMatchObject({ state: 'met' })
  await call(p.tok, 'notify_joey', { outcome: 'normal', text: 'WO-172 分身收到呼叫' })
  await call(p.tok, 'receipt', { outcome: 'done', happened: 't', did: 't', promised: '無', needs_main: '無' })
  await end(p.lane)
  expect(existsSync(dir)).toBe(true)
})

test('WO-177 (Chiron 04:01Z item 3; lab-relay.reflex.22 03:51:17 / 03:52:00, Onsen 42072 + 42073): once the lane hands the event to the main, the line to Joey is the main\'s — a raise of the lane\'s own earlier line is refused, nothing reaches Joey from the lane', async () => {
  const p = await start(mk('sonn', 'WO-177 驗收 8：跑 sleep 45 後告訴 Joey 完成', { line: 'call' }))
  const k = sent.length
  expect(await call(p.tok, 'notify_joey', { outcome: 'normal', text: '還在跑，確認之後我會再回一句' })).toContain('sent to Joey')
  expect(sent.length).toBe(k + 1)
  expect(await call(p.tok, 'handoff_main', { text: '請主線接手：讀背景輸出，回報 Joey' })).toContain('handed to the main')
  const out = await call(p.tok, 'notify_joey', { outcome: 'changed', text: 'WO-177 驗收 8 完成：輸出 done' })
  expect(out).toContain('this event is handed to the main: the main reports to Joey')
  expect(sent.length).toBe(k + 1)                                                        // the main's line is the only one that will follow
  expect(await call(p.tok, 'ask_joey', { text: '要不要重跑？' })).toContain('handed to the main')
  await call(p.tok, 'receipt', { outcome: 'done', happened: 't', did: '交主線', promised: '無', needs_main: '讀輸出、回報 Joey' })
  await end(p.lane)
  expect(sent.length).toBe(k + 1)
  // the main's item done (its line met): the event is the lane's again for a line of its own (a later run on the same matter)
  const main = obs(p.id).find(o => o.kind === 'main')!
  expect(main).toMatchObject({ state: 'open' })
})
