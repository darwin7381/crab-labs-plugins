// Universe 002l (D4, RV1 C07 #5): a main send that quotes a peer's message (reply_to) is filed, with its commitment, on THAT message's conversation; one
// with no conversation of its own gets a new one; the peer's newest unrelated thread is never guessed. design/identity rule 5 「承諾必入帳…主線下一次摘要
// 一定看到」. Jev is a local stand-in (it says every send promises something).
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
let server: any
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { await req.json(); return Response.json({ answers: { promises: { type: 'noul', noul: 0.93 } } }) } })
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`; process.env.TYPESAFE_API_KEY = 'k'
})
afterAll(() => { server.stop(true); L.__setClaudeBin(restore); delete process.env.LANES_PEER_NEW_PER_MIN })
const L = await import('./lanes.ts?d4-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-d4-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
const bin = join(dir, 'lane.sh'); writeFileSync(bin, '#!/bin/sh\nexit 0\n'); chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
L.__setMeshSend(async () => ({ text: 'sent', msgId: 1, delivered: true }))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: (a: string | undefined) => a === 'Bearer t0k',
  registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const outbound = async (b: object) => {
  const req: any = Object.assign((async function* () { yield Buffer.from(JSON.stringify(b)) })(), { method: 'POST', headers: { authorization: 'Bearer t0k' } })
  const res: any = { writeHead: () => res, end: () => {} }
  await L.handleLanesHttp(new URL('http://127.0.0.1/lanes/outbound'), req, res)
}
const ev = (id: string, btcc: string, text: string, extra: object = {}) => ({ id, source: 'mesh', from: 'eve', verified: true, btcc_msg_id: btcc, text, meta: {}, notif: { method: '', params: {} }, ...extra } as any)
const commitmentFor = (msgId: number) => rows().find(r => r.kind === 'commitment' && r.lane === 'main' && r.refs?.btcc_msg_id === msgId)

test('D4: the promise answers the quoted message: it is filed on that message\'s thread, not on the peer\'s newest live thread', async () => {
  const a = await L.routeEvent(ev('mesh-1', '50001', 'WO-27 的分類規格可以給我嗎？'))
  const b = await L.routeEvent(ev('mesh-2', '50002', 'mock-api 下週維護嗎？'))           // eve's newest live thread is this one
  const ta = st.lanes[a.lane!].thread, tb = st.lanes[b.lane!].thread
  st.threads[tb].last = new Date(Date.now() + 60_000).toISOString()
  await outbound({ msgId: 80001, owner: 'main', to: 'eve', text: 'WO-27 規格我明天 10:00 前給你。', thread: null, reply_to: 50001 })
  expect(await until(() => !!commitmentFor(80001))).toBe(true)
  expect(commitmentFor(80001)!.thread).toBe(ta); expect(commitmentFor(80001)!.refs.thread_from).toBe('reply_to')
  expect(commitmentFor(80001)!.thread).not.toBe(tb)
  expect(rows().find(r => r.event === 'main-send-80001' && r.kind === 'action')!.thread).toBe(ta)
})

test('D4: a quoted message that got no conversation (flood-blocked: ledger only) gets a new one for this exchange; nothing is filed on an unrelated thread', async () => {
  process.env.LANES_PEER_NEW_PER_MIN = '0.0001'                                            // eve is over her rate: the next new conversation is ledger-only
  st.flood = {}
  st.flood.eve = { bucket: 0, bucket_at: Date.now(), usage: [] } as any
  const d = await L.routeEvent(ev('mesh-3', '50021', '這週五前能幫我確認備份嗎？'))
  expect(d.rule).toBe('peer-flood')
  const before = new Set(Object.keys(st.threads))
  await outbound({ msgId: 80002, owner: 'main', to: 'eve', text: '好，我週五前確認備份後回你。', thread: null, reply_to: '50021' })
  expect(await until(() => !!commitmentFor(80002))).toBe(true)
  const c = commitmentFor(80002)!
  expect(c.refs.thread_from).toBe('reply_to-new')
  expect(before.has(c.thread)).toBe(false)                                                 // a new conversation, not WO-27's or any other existing one
  expect(st.threads[c.thread]).toMatchObject({ lane: 'main', peer: 'eve' })
  expect(st.outbound['80002'].thread).toBe(c.thread)                                       // eve's answer to this send comes back to the same conversation
})

test('D4: without reply_to the 002k fallbacks still apply (open promise, hand-over, live thread)', () => {
  expect(L.peerThread('eve').from).not.toBe('reply_to')
  expect(L.peerThread('eve', 'adam#t-x')).toEqual({ thread: 'adam#t-x', from: 'send' })
})
