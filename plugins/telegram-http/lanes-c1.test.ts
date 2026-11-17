// Universe 002k (C1): what the main promises in send_to_agent is recorded as a commitment (Jev, one narrow question). Jev is a local stand-in.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
let server: any, mode: 'high' | 'low' | 'edge' | 'fail' = 'high', calls = 0
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    calls++
    await req.json()
    if (mode === 'fail') return new Response('<html>blocked</html>', { status: 503 })
    return Response.json({ answers: { promises: { type: 'noul', noul: mode === 'high' ? 0.93 : mode === 'edge' ? 0.7 : 0.08 } } })
  } })
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`; process.env.TYPESAFE_API_KEY = 'k'
})
afterAll(() => { server.stop(true); delete process.env.LANES_MAIN_COMMITMENTS })
const L = await import('./lanes.ts?c1-test') as typeof import('./lanes.ts')
const ROUTER = process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json'
const dir = mkdtempSync(join(tmpdir(), 'lanes-c1-'))
process.env.LANES_DIR = dir
copyFileSync(ROUTER, join(dir, 'router.json'))
const logs: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: (_l: string, m: string) => { logs.push(m) },
  deliverToMain: () => {}, authOk: (a: string | undefined) => a === 'Bearer t0k', registryNames: () => ['eve', 'cain'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
L.__setMainConnected('mcp-main')
const st = L.__lanesState()
const rows = (): any[] => { try { return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
const outbound = async (b: object) => {
  const req: any = Object.assign((async function* () { yield Buffer.from(JSON.stringify(b)) })(), { method: 'POST', headers: { authorization: 'Bearer t0k' } })
  let code = 0; const res: any = { writeHead: (c: number) => { code = c; return res }, end: () => {} }
  await L.handleLanesHttp(new URL('http://127.0.0.1/lanes/outbound'), req, res)
  return code
}
const commitments = () => rows().filter(r => r.kind === 'commitment' && r.lane === 'main')
let id = 70000
const send = (text: string, to = 'eve', extra: object = {}) => outbound({ msgId: ++id, owner: 'main', to, text, thread: null, ...extra })
// eve has an open request: the router promised her an answer on thread adam#t-c1a (a promise), and has another live thread
st.threads['adam#t-c1a'] = { id: 'adam#t-c1a', lane: 'adam.reflex.1', peer: 'eve', hops: 1, tokens: 0, created: '', last: '2026-11-13T01:00:00Z' } as any
// M3: the router's promise is an answer the main owes eve, on that thread
L.__events().open('ev-c1', { class: 'peer', owner: 'main', thread: 'adam#t-c1a', obligations: [{ kind: 'peer', level: 'answer', owner: 'main', to: 'eve', what: '/v2/orders/bulk', due_at: Date.now() + 1_800_000 }] })
const c1ob = () => (L.__events().get('ev-c1')!.obligations as any[])[0]

test('C1: the main\'s send is an action line first, then a commitment (lane main, refs.auto) on the thread of the peer\'s open promise', async () => {
  mode = 'high'
  expect(await send('/v2/orders/bulk Joey 答應了。我會在明天 10:00 前把端點規格整理給你。')).toBe(200)
  expect(await until(() => commitments().length === 1)).toBe(true)
  const all = rows()
  const ai = all.findIndex(r => r.kind === 'action' && r.lane === 'main'), ci = all.findIndex(r => r.kind === 'commitment')
  expect(ai).toBeGreaterThanOrEqual(0); expect(ci).toBeGreaterThan(ai)                      // after the action line
  const c = commitments()[0]
  expect(c).toMatchObject({ kind: 'commitment', lane: 'main', thread: 'adam#t-c1a', refs: { auto: true, who: 'eve', from: 'main-send', thread_from: 'promise' } })
  expect(c.refs.p).toBeGreaterThanOrEqual(0.7); expect(c.refs.by).toContain('明天'); expect(c.text).toContain('答應 eve')
  expect(c1ob().state).toBe('open')                                            // 002k (C4): a send with no thread, no reply_to and no Jev match answers nothing in particular
  L.__events().set('ev-c1', c1ob().id, { state: 'met' })                                     // (the rest of this file is about commitments, not promises)
})

test('C1: p below 0.7 writes nothing; exactly 0.7 does', async () => {
  mode = 'low'
  const n = commitments().length
  await send('請你補端點規格（方法、欄位）。'); await sleep(200)
  expect(commitments().length).toBe(n)
  mode = 'edge'
  await send('我稍後告訴你誰做。', 'cain'); expect(await until(() => commitments().length === n + 1)).toBe(true)
  expect(commitments()[n].refs.who).toBe('cain'); expect(commitments()[n].thread).toBeNull()      // cain has no open request: thread null, not invented
})

test('C1: a Jev failure is an error, never a verdict: nothing is written, it is logged', async () => {
  mode = 'fail'
  const n = commitments().length, w = logs.length
  await send('我明天回你。', 'eve', { msgId: 70999 }); await sleep(300)
  expect(commitments().length).toBe(n)
  expect(logs.slice(w).some(m => m.includes('main commitment check') && m.includes('nothing written'))).toBe(true)
  const rec = readFileSync(join(dir, 'run', 'main-commitment.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).pop()
  expect(rec).toMatchObject({ to: 'eve', btcc_msg_id: 70999 }); expect(rec.error).toBeTruthy(); expect(rec.p).toBeUndefined()
})

test('C1: the env switch: LANES_MAIN_COMMITMENTS=0 asks nobody and writes nothing', async () => {
  mode = 'high'; process.env.LANES_MAIN_COMMITMENTS = '0'
  const n = commitments().length, c0 = calls
  await send('我會再回你。'); await sleep(200)
  expect(commitments().length).toBe(n); expect(calls).toBe(c0)
  delete process.env.LANES_MAIN_COMMITMENTS
})

test('C1: the main has a commitment tool; a send right after it does not record a second commitment', async () => {
  mode = 'high'
  expect(L.mainToolDefs().map((t: any) => t.name)).toContain('commitment'); expect(L.isMainTool('commitment')).toBe(true)
  expect(await L.callMainTool('commitment', { who: 'eve', what: '週五前補齊 /v2/orders/bulk 的實作排程', by: '週五前' }, 'some-other-session')).toStartWith('refused:')
  const n = commitments().length
  expect(await L.callMainTool('commitment', { who: 'eve', what: '週五前補齊 /v2/orders/bulk 的實作排程', by: '週五前' }, 'mcp-main')).toContain('commitment recorded')
  expect(await L.callMainTool('commitment', { who: '', what: 'x' }, 'mcp-main')).toContain('refused')
  const tool = commitments()[n]
  expect(tool.refs).toMatchObject({ who: 'eve', from: 'main-tool' }); expect(tool.refs.auto).toBeUndefined(); expect(tool.thread).toBe('adam#t-c1a')   // a promise is no longer open, the peer's live thread is
  const r = await L.mainCommitmentCheck({ msgId: 71001, to: 'eve', text: '週五前補齊實作排程', thread: L.peerThread('eve') })
  expect(r).toBe('dup'); expect(commitments().length).toBe(n + 1)
})

test('C1: the thread comes from the peer\'s open promise, then work handed to the main, then its live thread; the send\'s own thread wins', () => {
  st.threads['adam#t-c1b'] = { id: 'adam#t-c1b', lane: 'adam.reflex.2', peer: 'dan', hops: 1, tokens: 0, created: '', last: '2026-11-13T02:00:00Z' } as any
  st.threads['adam#t-c1c'] = { id: 'adam#t-c1c', lane: 'adam.reflex.3', peer: 'dan', hops: 1, tokens: 0, created: '', last: '2026-11-13T03:00:00Z' } as any
  expect(L.peerThread('dan')).toEqual({ thread: 'adam#t-c1c', from: 'peer-thread' })              // the newest live thread
  L.__events().open('ev-dan-h', { class: 'peer', owner: 'adam.reflex.2', thread: 'adam#t-c1b', obligations: [{ kind: 'main', level: 'handed', owner: 'main', handoff: 'h-dan' }] })
  expect(L.peerThread('dan')).toEqual({ thread: 'adam#t-c1b', from: 'handoff' })                  // work handed to the main from dan's thread
  L.__events().open('ev-dan-p', { class: 'peer', owner: 'main', thread: 'adam#t-c1c', obligations: [{ kind: 'peer', level: 'answer', owner: 'main', to: 'dan', what: 'x', due_at: Date.now() + 1000 }] })
  expect(L.peerThread('dan')).toEqual({ thread: 'adam#t-c1c', from: 'promise' })
  expect(L.peerThread('dan', 'adam#t-c1b')).toEqual({ thread: 'adam#t-c1b', from: 'send' })
  expect(L.peerThread('nobody')).toEqual({ thread: null, from: 'none' })
})
