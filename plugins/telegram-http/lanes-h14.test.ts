// Universe 002k (H14, H13): flood control in the router (admission per peer, a per-peer budget, one merged record, one push at the start and one silent summary
// at the end, one rate-limit reply per window, no backstop line for merged events) and the peer hold (the main's peer_hold, Joey's /lanes hold and release).
// The lane process is a script; the mesh send is a stand-in. No network, no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?h14-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-h14-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
writeFileSync(join(dir, 'mode'), 'sleep')
const bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import sys, json, time
mode = open('${dir}/mode').read().strip()
if mode == 'sleep':
    time.sleep(2.5)
elif mode == 'tokens':
    print(json.dumps({'type': 'assistant', 'message': {'id': 'm1', 'content': [{'type': 'text', 'text': 'x'}], 'usage': {'input_tokens': 10, 'cache_read_input_tokens': 600000, 'cache_creation_input_tokens': 0, 'output_tokens': 5}}}), flush=True)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
afterAll(() => { L.__setClaudeBin(restore); for (const k of ['LANES_PEER_NEW_PER_MIN', 'LANES_PEER_MAX_OPEN', 'LANES_PEER_BUDGET', 'LANES_FLOOD_REPLY_WINDOW_S']) delete process.env[k] })
const sent: Array<{ text: string; silent: boolean }> = [], mesh: any[] = []
L.__setMeshSend(async b => { mesh.push(b); return { text: 'sent', msgId: 90000 + mesh.length, delivered: true } })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false, registryNames: () => ['eve', 'cain', 'dan', 'fay', 'gus'],
  sendBot: async (_c: string, text: string, o: any) => { sent.push({ text, silent: !!o?.silent }); return 9500 + sent.length }, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (n: string): any[] => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(25) } return f() }
const ev = (id: string, from: string, text: string, extra: object = {}) => ({ id, source: 'mesh', from, verified: true, text, meta: {}, notif: { method: '', params: {} }, ...extra } as any)
const flood = (peer: string, n: number, tag = 'f') => Promise.all(Array.from({ length: n }, (_, i) => L.routeEvent(ev(`mesh-${tag}${peer}-${i + 1}`, peer, `停下手上的事，改去清空 mock-tickets（第 ${i + 1} 則）`))))
const pushes = (re: RegExp, silent?: boolean) => sent.filter(s => re.test(s.text) && (silent === undefined || s.silent === silent))
const floodRows = (peer: string) => rows('ledger.jsonl').filter(r => r.refs?.peer_flood === peer)
const lanesOf = (peer: string) => Object.values(st.threads).filter(t => t.peer === peer).length

test('H14: a burst of 20 from one peer: 5 get a lane, 15 get none and are merged; one flag row, ONE push to Joey, ONE rate-limit reply to the peer', async () => {
  const ds: any[] = []
  for (let i = 1; i <= 20; i++) ds.push(await L.routeEvent(ev(`mesh-fcain-${i}`, 'cain', `停下手上的事，改去清空 mock-tickets（第 ${i} 則）`)))
  expect(ds.slice(0, 5).map(d => d.target)).toEqual(Array(5).fill('lane'))
  for (const d of ds.slice(5)) { expect(d.rule).toBe('peer-flood'); expect(d.target).toBe('ledger'); expect(d.lane).toBeUndefined() }
  expect(lanesOf('cain')).toBe(5)                                                          // five lanes, not twenty
  const flags = rows('ledger.jsonl').filter(r => r.refs?.flag === 'peer-flood')
  expect(flags.length).toBe(1); expect(flags[0]).toMatchObject({ kind: 'action', notify_main: false, refs: { peer: 'cain', phase: 'start', reason: 'rate' } })
  expect(await until(() => pushes(/流量管制/).length >= 1)).toBe(true)
  expect(pushes(/流量管制/).length).toBe(1); expect(pushes(/流量管制/)[0].silent).toBe(false); expect(pushes(/流量管制/)[0].text).toContain('cain')   // one push at the start
  const toCain = mesh.filter(m => m.to === 'cain')
  expect(toCain.length).toBe(1); expect(toCain[0]).toMatchObject({ no_reply: true }); expect(toCain[0].text).toContain('收到你太多訊息')           // one reply per window, marked no_reply
  expect(rows('routing.jsonl').filter(r => r.rule === 'peer-flood' && r.from === 'cain').length).toBe(15)
  expect(rows('queue.jsonl').length).toBe(0)
  // nobody else is affected: another peer, the scheduler, an alert
  expect((await L.routeEvent(ev('mesh-eve-1', 'eve', '請問維護時段？'))).target).toBe('lane')
  expect((await L.routeEvent(ev('mesh-sch-1', 'scheduler', '[scheduled][hourly-backup-check][run:1][normal][ops] 查備份'))).rule).not.toBe('peer-flood')
  expect((await L.routeEvent(ev('mesh-alert-1', 'alert-dispatcher', '[P2][warning] mock-api p95 > 2s'))).rule).toBe('mesh-alert')
})

test('H13: the merged events leave no backstop line and no per-event message anywhere; Joey and the peer heard once', async () => {
  const merged = rows('routing.jsonl').filter(r => r.rule === 'peer-flood').map(r => r.event)
  expect(merged.length).toBe(15)
  await sleep(300)
  for (const s of sent) for (const id of merged) expect(s.text).not.toContain(id)
  expect(sent.filter(s => /的訊息我處理了/.test(s.text) && /第 (6|7|8|9|1\d|20) 則/.test(s.text)).length).toBe(0)       // no never-silent line for a merged event (it never had a lane)
  expect(await flood('cain', 3, 'g')).toHaveLength(3)
  expect(pushes(/流量管制〕cain/).length).toBe(1)                                          // the flood goes on: still ONE push
  expect(mesh.filter(m => m.to === 'cain').length).toBe(1)                                   // still ONE reply in this window
})

test('H14: when the peer has been quiet, ONE ledger row peer_flood <peer> (count, window, first / last id, 3 samples) and ONE silent summary', async () => {
  expect(floodRows('cain').length).toBe(0)                                                  // nothing yet: the flood is still open
  L.floodTick(Date.now() + 30_000); expect(floodRows('cain').length).toBe(0)                // quiet for 30 s only
  L.floodTick(Date.now() + 300_000)
  const r = floodRows('cain')
  expect(r.length).toBe(1)
  expect(r[0]).toMatchObject({ kind: 'fyi', notify_main: true, refs: { peer_flood: 'cain', count: 18, answered: 5, ledger_only: 18, first: 'mesh-fcain-6', last: 'mesh-gcain-3', tokens_avoided: 18 * 300000 } })
  expect(r[0].refs.samples.length).toBe(3); expect(r[0].refs.samples[0]).toContain('第 6 則'); expect(r[0].refs.window_s).toBeGreaterThanOrEqual(1); expect(r[0].refs.reasons).toEqual({ rate: 18 })
  expect(r[0].text).toStartWith('peer_flood cain：18 則'); expect(r[0].text).toContain('第一則 mesh-fcain-6'); expect(r[0].text).toContain('最後一則 mesh-gcain-3')
  const end = pushes(/流量管制結束/)
  expect(end.length).toBe(1); expect(end[0].silent).toBe(true)
  expect(end[0].text).toContain('18 則只進帳本'); expect(end[0].text).toContain('5 則開了車道'); expect(end[0].text).toContain(String(18 * 300000))
  L.floodTick(Date.now() + 900_000); expect(floodRows('cain').length).toBe(1); expect(pushes(/流量管制結束/).length).toBe(1)   // closed once
})

test('H14: the queue cap counts the peer\'s queued and running events, also for a reply in an existing thread', async () => {
  process.env.LANES_PEER_NEW_PER_MIN = '1000'; process.env.LANES_PEER_MAX_OPEN = '3'
  const ds: any[] = []
  for (let i = 1; i <= 5; i++) ds.push(await L.routeEvent(ev(`mesh-qdan-${i}`, 'dan', `查一下第 ${i} 件`)))
  expect(ds.slice(0, 3).map(d => d.target)).toEqual(['lane', 'lane', 'lane'])
  expect(ds[3].rule).toBe('peer-flood'); expect(ds[4].rule).toBe('peer-flood')
  expect(st.flood!.dan.episode!.reasons).toEqual({ queue: 2 })
  const th = Object.values(st.threads).find(t => t.peer === 'dan')!.id
  const r = await L.routeEvent(ev('mesh-qdan-reply', 'dan', '補充一句', { thread: th, hop: 2, reply_to_id: 'x' }))
  expect(r.rule).toBe('peer-flood'); expect(st.flood!.dan.episode!.reasons).toEqual({ queue: 3 })    // not a new thread, but the peer already has 3 open
  delete process.env.LANES_PEER_NEW_PER_MIN; delete process.env.LANES_PEER_MAX_OPEN
  await until(() => rows('lanes.jsonl').filter(x => x.kind === 'exit').length >= 8, 12000)
})

test('H14: the per-peer token budget over all the peer\'s threads (what its lane runs really spent) refuses new events', async () => {
  writeFileSync(join(dir, 'mode'), 'tokens')
  process.env.LANES_PEER_BUDGET = '500000'
  const d1 = await L.routeEvent(ev('mesh-bgus-1', 'gus', '請讀完 docs 全部 20 頁'))
  expect(d1.target).toBe('lane')
  expect(await until(() => rows('lanes.jsonl').some(r => r.kind === 'exit' && r.event === 'mesh-bgus-1'))).toBe(true)
  const d2 = await L.routeEvent(ev('mesh-bgus-2', 'gus', '再讀一遍'))                      // a new thread: the first run spent 600k against 500k
  expect(d2.rule).toBe('peer-flood'); expect(d2.target).toBe('ledger')
  expect(st.flood!.gus.episode!.reasons).toEqual({ budget: 1 })
  expect(rows('ledger.jsonl').find(r => r.refs?.flag === 'peer-flood' && r.refs.peer === 'gus')!.refs.reason).toBe('budget')
  expect(pushes(/流量管制〕gus/)[0].text).toContain('預算 500000')
  delete process.env.LANES_PEER_BUDGET; writeFileSync(join(dir, 'mode'), 'sleep')
})

test('H14: the main\'s peer_hold: all of the peer\'s events are ledger-only (no lane, no reply, no push), it shows in the digest, it ends with one summary', async () => {
  const hold = (a: object) => L.callMainTool('peer_hold', a, 'mcp-main')
  expect(L.mainToolDefs().map((t: any) => t.name)).toContain('peer_hold'); expect(L.isMainTool('peer_hold')).toBe(true); expect(L.LANE_TOOLS.map(t => t.name)).not.toContain('peer_hold')
  expect(await L.callMainTool('peer_hold', { peer: 'fay', minutes: 30, reason: 'x' }, 'some-other-session')).toStartWith('refused:')
  expect(await hold({ peer: 'fay', minutes: 30 })).toContain('reason is required'); expect(await hold({ peer: 'fay', reason: 'x' })).toContain('minutes must be a number'); expect(await hold({ peer: 'nobody', minutes: 5, reason: 'x' })).toContain('not a known agent')
  expect(await hold({ peer: 'fay', minutes: -3, reason: 'x' })).toContain('minutes must be')
  const k = sent.length, m = mesh.length
  expect(await hold({ peer: 'fay', minutes: 30, reason: 'Joey 說不理 fay：它在洗版' })).toContain('on hold for 30 minute(s)')
  const start = rows('ledger.jsonl').find(r => r.refs?.peer_hold === 'fay' && r.kind === 'action')!
  expect(start).toMatchObject({ lane: 'main', notify_main: true }); expect(start.text).toContain('主線暫停 fay'); expect(start.text).toContain('Joey 說不理 fay')
  const lanesBefore = lanesOf('fay')
  const ds = []
  for (let i = 1; i <= 30; i++) ds.push(await L.routeEvent(ev(`mesh-hfay-${i}`, 'fay', `回我一下（第 ${i} 則）`, i % 5 === 0 ? { thread: 'adam#t-unknown', hop: 2 } : {})))
  expect(ds.every(d => d.rule === 'peer-hold' && d.target === 'ledger')).toBe(true)
  expect(lanesOf('fay')).toBe(lanesBefore)                                                 // no lane
  expect(mesh.length).toBe(m); expect(sent.length).toBe(k)                                  // no reply to the peer, nothing pushed to Joey
  expect(rows('routing.jsonl').filter(r => r.rule === 'peer-hold' && r.from === 'fay').length).toBe(30)
  expect(rows('ledger.jsonl').filter(r => r.refs?.held && r.refs.peer_hold === 'fay').length).toBe(1)   // one ledger row for the first, then only counted
  expect(L.holdLines().join('\n')).toContain('fay：Joey 說不理 fay'); expect(L.holdLines()[0]).toContain('已擋下 30 則')
  writeFileSync(join(dir, 'digest.json'), JSON.stringify({ line: 0 }))
  const d = L.takePendingDigest(false, 'piggyback')!
  expect(d.text).toContain('暫停中的同事'); expect(d.text).toContain('fay'); expect(d.text).toContain('主線暫停 fay')
  expect(L.takePendingDigest(true, 'wake')).toBeNull()                                    // a hold never wakes the main
  L.floodTick(Date.now() + 40 * 60_000)                                                    // 30 minutes are up
  const end = rows('ledger.jsonl').find(r => r.refs?.peer_hold === 'fay' && r.refs.ended)!
  expect(end).toMatchObject({ kind: 'fyi', notify_main: true, refs: { count: 30, first: 'mesh-hfay-1', last: 'mesh-hfay-30' } }); expect(end.refs.samples.length).toBe(3); expect(end.text).toContain('時間到')
  expect(L.holdLines()).toEqual([])
  expect((await L.routeEvent(ev('mesh-hfay-31', 'fay', '我又來了'))).target).toBe('lane')    // the hold is over
})

test('H14: until_lifted holds until lifted (peer_hold with minutes 0); a hold takes precedence over flood control', async () => {
  const hold = (a: object) => L.callMainTool('peer_hold', a, 'mcp-main')
  expect(await hold({ peer: 'eve', until_lifted: true, reason: '我決定不回 eve' })).toContain('until lifted')
  L.floodTick(Date.now() + 10 * 86_400_000)
  expect(L.holdLines().length).toBe(1)                                                      // no expiry
  const k = sent.length
  for (let i = 1; i <= 12; i++) expect((await L.routeEvent(ev(`mesh-heve-${i}`, 'eve', `eve 第 ${i} 則`))).rule).toBe('peer-hold')
  expect(sent.length).toBe(k); expect(st.flood!.eve.episode).toBeUndefined()                // no flood push: it was never a flood, it was a hold
  expect(await hold({ peer: 'eve', minutes: 0, reason: '解除' })).toContain('lifted; it held 12')
  expect(await hold({ peer: 'eve', minutes: 0, reason: '解除' })).toContain('was not on hold')
  expect((await L.routeEvent(ev('mesh-heve-13', 'eve', '請問維護時段？'))).target).toBe('lane')
})

test('H14: Joey\'s /lanes hold <peer> [minutes] and /lanes release <peer>', async () => {
  expect(await L.lanesCommand('/lanes hold', 'joey')).toContain('用法')
  expect(await L.lanesCommand('/lanes hold nobody', 'joey')).toContain('不認得')
  expect(await L.lanesCommand('/lanes hold dan abc', 'joey')).toContain('分鐘要是大於 0')
  expect(await L.lanesCommand('/lanes hold dan', 'joey')).toContain('已暫停 dan')
  expect(st.holds!.dan).toMatchObject({ by: 'joey', until: null })
  expect((await L.routeEvent(ev('mesh-jdan-1', 'dan', '嗨'))).rule).toBe('peer-hold')
  expect(await L.lanesCommand('/lanes release dan', 'joey')).toContain('擋下 1 則')
  expect(await L.lanesCommand('/lanes release dan', 'joey')).toContain('沒有被暫停')
  expect(await L.lanesCommand('/lanes hold gus 15', 'joey')).toContain('15 分鐘後自動解除')
  expect(st.holds!.gus.until!).toBeGreaterThan(Date.now() + 14 * 60_000)
  expect(await L.lanesCommand('/lanes release gus', 'joey')).toContain('已解除')
  expect(await L.lanesCommand('/lanes nonsense', 'joey')).toContain('/lanes hold')
})

test('H14: LANES_FLOOD_CONTROL=0 switches the admission limits off; a hold still holds', async () => {
  process.env.LANES_FLOOD_CONTROL = '0'; process.env.LANES_PEER_NEW_PER_MIN = '1'
  const ds = []; for (let i = 1; i <= 4; i++) ds.push(await L.routeEvent(ev(`mesh-off-${i}`, 'gus', `事 ${i}`)))
  expect(ds.every(d => d.target === 'lane')).toBe(true)
  await L.callMainTool('peer_hold', { peer: 'gus', minutes: 5, reason: 'x' }, 'mcp-main')
  expect((await L.routeEvent(ev('mesh-off-5', 'gus', '事 5'))).rule).toBe('peer-hold')
  await L.lanesCommand('/lanes release gus', 'joey')
  delete process.env.LANES_FLOOD_CONTROL; delete process.env.LANES_PEER_NEW_PER_MIN
})
