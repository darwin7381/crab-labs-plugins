// 002w (C): every place that stops a conversation goes through stopThread (the event record's `stop`, the router's stop notice marked no_reply, the
// hand-over to the main), and ONE outbound gate decides a send on a thread: a no_reply send passes a stopped or over-limit thread without counting a hop
// (it asks for nothing: it cannot extend the loop). The tg daemon's /lanes/ routes run behind a real HTTP server here, and an inbox-role instance asks
// it the way the inbox daemon does (checkMainSend). Each test names the path and the gap of DUTY-INVENTORY.md. A fake lane binary, a mesh stub; no model.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
process.env.LANES_FLOOD_CONTROL = '0'
let L: typeof import('./lanes.ts')
const srv = createServer((req, res) => { void L.handleLanesHttp(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res) })
await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
const PORT = (srv.address() as AddressInfo).port
process.env.LANES_TG_PORT = String(PORT)
L = await import('./lanes.ts?w-c-test') as typeof import('./lanes.ts')
const I = await import('./lanes.ts?w-c-inbox') as typeof import('./lanes.ts')     // the inbox daemon's side
delete process.env.LANES_TG_PORT
const dir = mkdtempSync(join(tmpdir(), 'lanes-w-c-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const GO = join(dir, 'go'), bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
t0 = time.time()
while time.time() - t0 < 60 and not os.path.exists('${GO}'): time.sleep(0.02)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
const meshOut: any[] = []
L.__setMeshSend(async b => { meshOut.push(b); return { text: `sent to ${b.to}`, msgId: 63000 + meshOut.length, delivered: true } })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve', 'cain'],
  sendBot: async () => 1, joeyChatId: () => '1' } as any)
const idir = mkdtempSync(join(tmpdir(), 'lanes-w-c-inbox-'))
process.env.LANES_DIR = idir
I.lanesInit({ role: 'inbox', agent: 'adam', workspaceDir: idir, transcriptDir: idir, httpPort: 0, log: () => {}, authOk: () => true, registryNames: () => ['eve'] } as any)
process.env.LANES_DIR = dir
afterAll(() => { try { writeFileSync(GO, 'ok') } catch {}; L.__setClaudeBin(restore); srv.close(); delete process.env.LANES_FLOOD_CONTROL })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const st = L.__lanesState(), E = () => L.__events()
let n = 0
const mk = (text: string, extra: object = {}) => ({ id: `mesh-wc-${++n}`, source: 'mesh', from: 'eve', verified: true, text, btcc_msg_id: String(64000 + n), meta: {}, notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } }, ...extra } as any)
const handoffs = (ev: string) => L.__main().items((r: any) => r.kind === 'handoff' && r.event === ev)
const notices = (k: number) => meshOut.slice(k).filter(b => b.no_reply === true && String(b.text).includes('自動往來的上限'))
/** eve's message opens a reflex lane whose run waits; its thread is put at the hop limit */
async function atLimit(text: string): Promise<{ ev: any; lane: string; th: string }> {
  const ev = mk(text)
  const d = await L.routeEvent(ev)
  expect(d.target).toBe('lane')
  expect(await until(() => !!L.__runTok(d.lane!))).toBe(true)
  const th = st.lanes[d.lane!].thread
  st.threads[th].hops = 6
  return { ev, lane: d.lane!, th }
}
async function done(lane: string) { writeFileSync(GO, 'ok'); await until(() => !L.__runTok(lane)); await sleep(50) }

test('002w C, gap 1, path the main\'s closing answer on a stopped conversation (inbox daemon → /lanes/outbound-check): a no_reply send passes without counting a hop; without no_reply it is refused', async () => {
  const a = await atLimit('週三 14:00 維護，確定嗎？')
  const stopped = await L.routeEvent(mk('再確認一次', { thread: a.th, hop: 7, reply_to_id: 'x' }))       // the router's thread gate stops it
  expect(stopped.rule).toBe('thread-gate'); expect(st.threads[a.th].stopped).toBeTruthy()
  const hops = st.threads[a.th].hops
  expect(await I.checkMainSend(a.th, hops + 1, true)).toMatchObject({ ok: true })                         // 2a936a7: refused (thread stopped), whatever no_reply said
  expect(st.threads[a.th].hops).toBe(hops)                                                                // not counted
  expect(await I.checkMainSend(a.th, hops + 1)).toMatchObject({ ok: false })
  await done(a.lane)
})

test('002w C, gap 15, path the main\'s send past the hop limit (/lanes/outbound-check): the conversation is stopped through stopThread: the record\'s stop, the router\'s no_reply notice to the peer, the hand-over (2a936a7: only refused)', async () => {
  const a = await atLimit('報告格式要改嗎？')
  const k = meshOut.length
  const c = await I.checkMainSend(a.th, 7)
  expect(c.ok).toBe(false)
  expect(st.threads[a.th].stopped).toContain('hop 7')
  expect(E().get(a.ev.id)!.stop).toMatchObject({ why: 'hop', thread: a.th })
  expect(await until(() => notices(k).length === 1)).toBe(true)
  expect(notices(k)[0]).toMatchObject({ to: 'eve', reply_to: a.ev.btcc_msg_id })
  expect(handoffs(a.ev.id).length).toBe(1)                                                                  // now, not when the lane's run ends
  await done(a.lane)
  expect(handoffs(a.ev.id).length).toBe(1)
})

test('002w C, gap 15, path a lane\'s reply_agent past the hop limit: through stopThread: the record\'s stop, the notice, the hand-over now (2a936a7: the thread was marked stopped, nobody told, the event handed over only when the run ended)', async () => {
  const a = await atLimit('可以把 timeout 改成 5 秒嗎？')
  const k = meshOut.length
  const out = await L.callLaneTool(L.__runTok(a.lane)!, 'reply_agent', { line: 'call', because: 'test (the call line)', to: 'eve', text: '可以，已改。' })
  expect(out).toContain('blocked')
  expect(st.threads[a.th].stopped).toBeTruthy()
  expect(E().get(a.ev.id)!.stop).toMatchObject({ why: 'hop' })
  expect(await until(() => notices(k).length === 1)).toBe(true)
  expect(handoffs(a.ev.id).length).toBe(1)                                                                  // while the run still runs
  expect(L.__runTok(a.lane)).toBeTruthy()
  await done(a.lane)
})

test('002w C, gap 15, path interimToPeer past the hop limit (handoff_main): the conversation is stopped through stopThread, the peer told (2a936a7 skipped it silently)', async () => {
  const a = await atLimit('能不能先答應週五給？')
  const k = meshOut.length
  expect(await L.callLaneTool(L.__runTok(a.lane)!, 'handoff_main', { text: 'eve 要週五，要主線決定' })).toContain('handed to the main')
  expect(await until(() => notices(k).length === 1)).toBe(true)
  expect(st.threads[a.th].stopped).toBeTruthy()
  expect(E().get(a.ev.id)!.stop).toMatchObject({ why: 'hop' })
  expect(handoffs(a.ev.id).length).toBe(1)                                                                  // one hand-over: the stop did not add a second
  await done(a.lane)
})

// lanes-golive (A5): on the call line the answer to a call (reply_to) is the no_reply send (fleet three-line rule); no_reply alone is a mail field
test('002w C, path a lane\'s reply_agent answering a call (reply_to = no_reply) on a stopped thread: the one gate lets it through without counting a hop (2a936a7 blocked it)', async () => {
  const a = await atLimit('收到嗎？')
  st.threads[a.th].stopped = 'hop 7 > limit 6'
  const out = await L.callLaneTool(L.__runTok(a.lane)!, 'reply_agent', { line: 'call', to: 'eve', text: '收到，這段先停在這裡。', reply_to: '424242' })
  expect(out).toContain('sent to eve')
  expect(st.threads[a.th].hops).toBe(6)
  expect(meshOut.at(-1)).toMatchObject({ to: 'eve', no_reply: true, hop: 6 })
  await done(a.lane)
})
