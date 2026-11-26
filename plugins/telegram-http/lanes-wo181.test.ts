// WO-181 (the plugin half) in M1 (lanes-main.ts) with the real MentionCards (onsen-mentions.ts) against a stand-in Onsen answer: the unread mentions ride
// the main's deliveries with the digest, in the same place and the same go.
//   1 an idle main is offered Joey's message: the block (Chiron's title, the PostCard line verbatim) rides in the digest before the message; then each post
//     is marked read (PUT /v1/posts/<id>/read); the next delivery has none
//   2 the offer did not go (no stream): nothing marked; the offer that goes carries the block, then the read
//   3 a busy main pulls at a tool boundary / at its Stop: the block rides the pulled text; marked read
//   4 nothing to deliver: the mentions wake nobody (no GET, no offer, no wake row)
//   5 Onsen 500 / slow: the delivery goes without the block, one log line; nothing marked
//   6 switched off: no GET, the delivery as before
// No transcript, no model, no network (real processes stand in for the main, as in lanes-m2-main).
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { MentionCards } from './onsen-mentions.ts'
const L = await import('./lanes.ts?wo181-test') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo181-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const offers: Array<{ sid: string; notif: any }> = [], open = new Set<string>(), logs: string[] = []
// the stand-in Onsen: lab-relay's unread mentions, read when PUT /v1/posts/<id>/read arrives
let on = true, onsenMode: 'ok' | 'error' | 'slow' = 'ok'
const unread = new Map<string, string>(), calls: Array<{ m: string; path: string; body: unknown }> = []
const line = (id: string) => `#${id}｜11-26 13:05｜chiron｜留言｜WO-181 請你定：點名短卡的標題｜工單 WO-181`
const onsenReq = async (m: 'GET' | 'PUT', path: string, body: unknown): Promise<{ status: number; json: any } | null> => {
  calls.push({ m, path, body })
  if (onsenMode === 'error') return { status: 500, json: { error: { code: 'internal', message: 'x' } } }
  if (onsenMode === 'slow') return new Promise(() => {})
  if (m === 'PUT') { const id = path.split('/')[3]!; unread.delete(id); return { status: 200, json: { data: { post_id: id, read_at: '2026-11-26T05:10:00Z' } } } }
  const ids = [...unread.keys()].reverse()
  return { status: 200, json: { items: ids.map(i => ({ id: `nt_${i}`, recipient: 'adam', post_id: i, reason: 'mention', created_at: '2026-11-26T05:05:00Z', read_at: null })),
    next_cursor: null, counts: { wall: 9, thread: 2, mention: ids.length, assignment: 0 }, cards: ids.map(i => ({ post_id: i, line: unread.get(i) })) } }
}
const mc = new MentionCards({ on: () => on, req: (m, p, b) => onsenReq(m, p, b), timeoutMs: () => 150, log: (_l, m) => logs.push(m) })
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: (_l: string, m: string) => logs.push(m), authOk: () => false, registryNames: () => ['eve'],
  notifySession: async (sid: string, notif: any) => { if (!open.has(sid)) return false; offers.push({ sid, notif }); return true },
  streamOpen: (sid: string) => open.has(sid), sendBot: async () => 1, joeyChatId: () => '1',
  mentions: () => mc.fetchIfOn(), mentionsRead: (posts: string[]) => mc.read(posts) } as any)
L.__setWallProbe(3_600_000)
const procs: any[] = []
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } L.__setWallProbe(300_000) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000): Promise<boolean> { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(10) } return fn() }
const M = () => L.__main()
type Gen = { pid: number; sid: string; proc: any; mcp: string }
async function startMain(): Promise<Gen> {
  const p = Bun.spawn(['sleep', '600']); procs.push(p)
  const sid = randomUUID()
  writeFileSync(join(dir, 'main-expected'), sid)
  const g = { pid: p.pid, sid, proc: p, mcp: `mcp-${p.pid}` }
  open.add(g.mcp); L.__noteMcpPid(g.mcp, p.pid)
  await L.__mainEvent({ event: 'SessionStart', pid: p.pid, session_id: sid, source: 'startup' })
  await M().pump()
  return g
}
const hook = (g: Gen, event: string, o: object = {}) => L.__mainEvent({ event, pid: g.pid, session_id: g.sid, ...o })
let nj = 0
async function joey(text: string): Promise<string> {
  const id = ++nj + 700, meta = { chat_id: '1', message_id: String(id), user: 'joey_lab' }
  await L.routeEvent({ id: `tg-1-${id}`, source: 'telegram', from: 'joey', text, meta, verified: true, notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)
  await M().pump()
  return M().items(r => r.event === `tg-1-${id}`)[0].id
}
const state = (id: string) => M().items(r => r.id === id)[0]?.state
const TITLE = (n: number) => `〔點名你的動態｜${n} 則。別人在你的單或你名下的串上說了什麼；只讓你知道，要看全文用 feed_open〕`
const gets = () => calls.filter(c => c.m === 'GET').length
const wakeLines = () => { try { return readFileSync(join(dir, 'lanes', 'state.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.rec === 'wake').length } catch { return -1 } }
const puts = () => calls.filter(c => c.m === 'PUT').map(c => c.path)
let np = 0
const P = () => `p181-${++np}`
async function close(g: Gen, p: string): Promise<void> { await hook(g, 'Stop', { prompt_id: p }); await hook(g, 'Stop', { prompt_id: p, phase: 'final' }); await M().pump() }

let g: Gen
test('1 an idle main is offered Joey\'s message: the block rides with the digest before the message, the line verbatim; then each post is read; the next delivery has none', async () => {
  g = await startMain()
  unread.set('200301', line('200301'))
  const k = offers.length, c0 = calls.length
  const id = await joey('lab-relay 測試：點名短卡')
  expect(await until(() => state(id) === 'offered')).toBe(true)                               // after the GET (in flight while the router returned)
  const content = String(offers.at(-1)!.notif.params.content)
  expect(offers.length).toBe(k + 1)
  expect(content).toContain(`${TITLE(1)}\n${line('200301')}\n〔以上是系統附上的車道摘要，只附這一次；以下才是這則訊息本身〕\nlab-relay 測試：點名短卡`)
  expect(calls.slice(c0).map(c => [c.m, c.path])).toEqual([['GET', '/v1/notifications?reason=mention&read=unread&limit=20'], ['PUT', '/v1/posts/200301/read']])
  expect(calls.at(-1)!.body).toEqual({ read: true })
  expect(unread.size).toBe(0)                                                                 // counts.mention one less
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] }); await close(g, p)
  const id2 = await joey('再一次')
  expect(await until(() => state(id2) === 'offered')).toBe(true)
  expect(String(offers.at(-1)!.notif.params.content)).not.toContain('點名你的動態')          // 2: nothing unread: no block, not an empty title
  const p2 = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p2, dids: [id2] }); await close(g, p2)
})

test('2 the offer did not go (the main has no stream): nothing marked; the offer that goes carries the block, then the read', async () => {
  unread.set('200302', line('200302'))
  open.delete(g.mcp)
  const id = await joey('沒有串的時候')
  expect(state(id)).toBe('queued')
  expect(puts().filter(p => p.includes('200302'))).toEqual([])
  expect(unread.has('200302')).toBe(true)
  open.add(g.mcp); await M().pump()
  expect(await until(() => state(id) === 'offered')).toBe(true)
  expect(String(offers.at(-1)!.notif.params.content)).toContain(`${TITLE(1)}\n${line('200302')}`)
  expect(await until(() => !unread.has('200302'))).toBe(true)
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] }); await close(g, p)
})

test('3 a busy main pulls at a tool boundary and at its Stop: the block rides the pulled text, marked read once bound', async () => {
  const id = await joey('開一個回合'); const p = P()
  expect(await until(() => state(id) === 'offered')).toBe(true)
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] })
  await hook(g, 'PreToolUse', { prompt_id: p, tool_name: 'Bash' })
  unread.set('200303', line('200303'))
  const g0 = gets()
  const id2 = await joey('回合中送到的')                                                       // busy: queued, pulled at the next boundary
  expect(state(id2)).toBe('queued')
  expect(gets()).toBe(g0)                                                                     // no offer, no fetch: the mentions wake nobody
  const r = await hook(g, 'PostToolUse', { prompt_id: p, tool_name: 'Bash', tool_response: 'ok' })
  expect(state(id2)).toBe('bound')
  expect(String(r.additionalContext)).toContain('〔交給主線｜')
  expect(String(r.additionalContext)).toContain(`${TITLE(1)}\n${line('200303')}`)
  expect(await until(() => !unread.has('200303'))).toBe(true)
  // at the Stop
  unread.set('200304', line('200304'))
  const id3 = await joey('回合要結束時送到的')
  const s = await hook(g, 'Stop', { prompt_id: p })
  expect(String(s.block)).toContain(`${TITLE(1)}\n${line('200304')}`)
  expect(state(id3)).toBe('bound')
  expect(await until(() => !unread.has('200304'))).toBe(true)
  await close(g, p)
})

test('4 nothing to deliver: unread mentions wake nobody (no GET, no offer, no wake row)', async () => {
  unread.set('200305', line('200305'))
  const g0 = gets(), k = offers.length, w0 = wakeLines()
  await M().pump(); await M().tick(); await sleep(50)
  expect(gets()).toBe(g0); expect(offers.length).toBe(k)
  expect(w0).toBeGreaterThan(0)                                                               // (the earlier deliveries wrote theirs)
  expect(wakeLines()).toBe(w0)
})

test('5 Onsen erroring or slow: the delivery goes without the block (one log line), nothing marked; back up: the next delivery carries it', async () => {
  for (const mode of ['error', 'slow'] as const) {
    onsenMode = mode
    const l0 = logs.length, k = offers.length, t0 = Date.now()
    const id = await joey(`Onsen ${mode}`)
    expect(await until(() => state(id) === 'offered', 2000)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(offers.length).toBe(k + 1)
    expect(String(offers.at(-1)!.notif.params.content)).not.toContain('點名你的動態')
    expect(logs.slice(l0).filter(x => x.startsWith('lanes: mention cards:'))).toHaveLength(1)
    expect(unread.has('200305')).toBe(true)
    const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] }); await close(g, p)
  }
  onsenMode = 'ok'
  const id = await joey('Onsen 回來了')
  expect(await until(() => state(id) === 'offered')).toBe(true)
  expect(String(offers.at(-1)!.notif.params.content)).toContain(line('200305'))
  expect(await until(() => !unread.has('200305'))).toBe(true)
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] }); await close(g, p)
})

test('6 switched off (LANES_MENTION_CARDS does not list the agent): no GET, the delivery as before', async () => {
  on = false
  unread.set('200306', line('200306'))
  const g0 = gets()
  const id = await joey('關掉的時候')
  expect(state(id)).toBe('offered')
  expect(gets()).toBe(g0)
  expect(String(offers.at(-1)!.notif.params.content)).not.toContain('點名你的動態')
  const p = P(); await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [id] }); await close(g, p)
  on = true
})
