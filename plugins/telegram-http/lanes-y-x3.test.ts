// Universe 002y (X-3; 002w r1 B09, u002w-B09-s5-r1-20261120-125209 lanes/state.jsonl 57-58): a reflex lane that cannot decide a peer's request hands it
// to the main (handoff_main) and may also answer the peer itself (reply_agent). The peer is told ONCE when the main will answer (the router's interim)
// and the main owes that answer, in either order of the two calls. Before: the lane's reply came first and met the answer, the hand-over found nothing
// owed, the interim was skipped; Eve never got the time and the main never owed her an answer. The lane is a script that waits for the test; no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?y-x3-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-y-x3-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const GO = join(dir, 'go')
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
t0 = time.time()
while time.time() - t0 < 30:
    if os.path.exists('${GO}'):
        os.remove('${GO}'); break
    time.sleep(0.02)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
L.__setRetryBackoff(20)
const sent: string[] = [], mesh: any[] = []
let hold: Promise<void> | null = null
L.__setMeshSend(async b => { if (hold) await hold; mesh.push(b); return { text: `sent to ${b.to}`, msgId: 81000 + mesh.length, delivered: true } })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (_c: string, text: string) => { sent.push(text); return 9100 + sent.length }, joeyChatId: () => '1' } as any)
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; L.__setClaudeBin(restore); L.__setMeshSend(null); L.__setRetryBackoff(5000); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const E = () => L.__events()
const peers = (id: string): any[] => ((E().get(id)?.obligations ?? []) as any[]).filter(o => o.kind === 'peer')
let n = 0
const ask = (text: string) => { const k = ++n; return { id: `mesh-y3-${k}`, source: 'mesh', from: 'eve', verified: true, text, btcc_msg_id: String(50100 + k), meta: {},
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }
async function start(ev: any): Promise<{ id: string; lane: string; tok: any; req: string }> {
  const d = await L.routeEvent(ev)
  expect(d.target).toBe('lane')
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  return { id: ev.id, lane: d.lane!, tok: L.__runTok(d.lane!)!, req: ev.btcc_msg_id }
}
async function end(lane: string): Promise<void> { writeFileSync(GO, 'ok'); expect(await until(() => !L.__runTok(lane))).toBe(true); await sleep(40) }
/** the lane's own reply to Eve; a reply that says the main has it before the record does is sent back once (ownerClaimWarning): the lane sends it again */
async function ownReply(tok: any, text: string): Promise<string> {
  const r = await L.callLaneTool(tok, 'reply_agent', { to: 'eve', text })
  return r.startsWith('not sent') ? L.callLaneTool(tok, 'reply_agent', { to: 'eve', text }) : r
}
const interims = (k: number) => mesh.slice(k).filter(m => m.owner === '主線' && String(m.text).includes('主線會在'))
/** what the duty asks, whichever call came first: the peer was told once when the main answers (the router's interim, met); the answer is the main's
 *  (owner main, open, due, the request it answers); the lane's reply is its own line (message, met); the main's Stop check asks for the answer */
function mainOwes(id: string, req: string, lanesOwnLine = true): void {
  const ps = peers(id)
  expect(ps.filter(o => o.level === 'interim')).toEqual([expect.objectContaining({ state: 'met', owner: 'router', to: 'eve' })])
  const ans = ps.filter(o => o.level === 'answer')
  expect(ans.length).toBe(1)
  expect(ans[0]).toMatchObject({ owner: 'main', state: 'open', to: 'eve', req }); expect(ans[0].due_at).toBeGreaterThan(Date.now())
  if (lanesOwnLine) expect(ps.filter(o => o.level === 'message')).toEqual([expect.objectContaining({ state: 'met', to: 'eve', by: 'reply_agent' })])
  expect(E().mainObs(id).filter(o => o.kind === 'peer').map(o => o.id)).toEqual([ans[0].id])
  expect(E().get(id)!.state).toBe('open')
}

test('002y X-3, reply first (B09 r1): the lane answered Eve (「重啟由主線處理」) and then handed the request over: Eve is told once when the main answers, the main owes her the answer, the lane\'s reply stays its own line', async () => {
  const k = mesh.length
  const p = await start(ask('mock-api 好像卡住了，可以幫我重啟一下嗎？我的稿件通知要經過它。'))
  expect(await ownReply(p.tok, '我查到 mock-api p95 2600ms、health degraded。重啟由主線處理，我已經交給主線。')).toContain('sent to eve')
  expect(peers(p.id).find(o => o.level === 'answer')).toMatchObject({ state: 'met', by: 'reply_agent' })   // the reply met the answer (as in B09 r1, 02:00:42.118Z)
  const out = await L.callLaneTool(p.tok, 'handoff_main', { text: 'Eve 請求重啟 mock-api；焦點卡寫別碰 mock-api 重啟，要主線決定' })
  expect(out).toContain('The router told eve')
  expect(interims(k).length).toBe(1); expect(interims(k)[0]).toMatchObject({ to: 'eve', reply_to: p.req })
  mainOwes(p.id, p.req)
  expect(await L.callLaneTool(p.tok, 'reply_agent', { to: 'eve', text: '再補一句' })).toContain('eve already got a message about this event')   // still one line of its own
  await end(p.lane)
  expect(interims(k).length).toBe(1)                                                         // once
  const s0 = sent.length, due = peers(p.id).find(o => o.level === 'answer').due_at
  L.dueTick(due + 1); await sleep(20); L.dueTick(due + 2); await sleep(20)                   // owed by the main: past its due time Joey is told, once
  expect(sent.slice(s0).filter(t => t.includes('eve 在等主線回覆') && t.includes('mock-api 好像卡住了')).length).toBe(1)
  await L.mainSentTo('eve', E().get(p.id)!.thread, null, '重啟好了', '81999')                    // the main's answer meets it
  expect(peers(p.id).find(o => o.level === 'answer')).toMatchObject({ state: 'met', ref: '81999' })
})

test('002y X-3, hand-over first (B09 r2, it worked): the same end state as the other order', async () => {
  const k = mesh.length
  const p = await start(ask('可以幫我重啟 mock-api 嗎？'))
  expect(await L.callLaneTool(p.tok, 'handoff_main', { text: 'Eve 請求重啟 mock-api，要主線決定' })).toContain('The router told eve')
  expect(await ownReply(p.tok, '我查到 mock-api p95 2600ms、health degraded。重啟由主線處理。')).toContain('sent to eve')
  mainOwes(p.id, p.req)
  await end(p.lane)
  expect(interims(k).length).toBe(1)
})

test('002y X-3, the two calls at once: the reply still in flight when the request is handed over: Eve is told once, the main owes the answer', async () => {
  const k = mesh.length
  const p = await start(ask('mock-api 能不能重啟一下？'))
  let release!: () => void
  hold = new Promise<void>(r => { release = r })
  const reply = L.callLaneTool(p.tok, 'reply_agent', { to: 'eve', text: '我查到 p95 2600ms，health degraded。' })
  expect(await until(() => peers(p.id).some(o => o.level === 'answer' && o.state === 'requested'))).toBe(true)
  const hand = L.callLaneTool(p.tok, 'handoff_main', { text: 'Eve 請求重啟 mock-api，要主線決定' })
  expect(await until(() => ((E().get(p.id)?.obligations ?? []) as any[]).some(o => o.kind === 'main'))).toBe(true)
  hold = null; release()
  expect(await reply).toContain('sent to eve'); expect(await hand).toContain('The router told eve')
  mainOwes(p.id, p.req, false)                                                               // the in-flight reply was handed over with the request (not recorded as its own line)
  await end(p.lane)
  expect(interims(k).length).toBe(1)
})

test('002y X-3, not a hand-over of the request: the lane answered Eve and its run ended owing Joey a line: the exit rule hands that over; Eve\'s answer stays answered, no interim', async () => {
  const k = mesh.length
  const p = await start(ask('mock-api 的 p95 現在多少？'))
  expect(await L.callLaneTool(p.tok, 'reply_agent', { to: 'eve', text: 'p95 現在 190ms。' })).toContain('sent to eve')
  await end(p.lane)
  expect(((E().get(p.id)?.obligations ?? []) as any[]).some(o => o.kind === 'main')).toBe(true)   // handed by the exit rule (the Joey line)
  expect(peers(p.id)).toEqual([expect.objectContaining({ level: 'answer', state: 'met', by: 'reply_agent' })])
  expect(interims(k).length).toBe(0)
})
