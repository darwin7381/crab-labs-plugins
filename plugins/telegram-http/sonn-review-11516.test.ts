// Sonn's review #11516 of the WO-142 lanes path (fixed in 743ba39): regression tests for its three points.
//  (1) lanes-main.ts pump: while `await E.offer(...)` is in flight the item is still `queued`; an edit rewrote it (replaceQueued) and the main got the OLD
//      text while Onsen recorded replaced_in_queue. The ids in flight are skipped: the edit then goes as a new message (server.ts).
//  (2) lanes.ts replyTargets: reply_to is matched with the chat (a DM and a group share Telegram numbers), and the two match methods are merged (items
//      carrying message_id N, events whose record tg.message_id is N): a lane's hand-over of N and Joey's edit of N in one turn are both met.
//  (3) server.ts: an edit's lanes event id carries a per-process counter. No test here: see the note at the end of this file.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?sonn-11516') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-sonn-11516-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER!, join(dir, 'router.json'))
// a lane run (2b): waits for the GO file, then ends with a success result (lanes-golive-replyto.test.ts)
const GO = join(dir, 'go'), bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
t0 = time.time()
while time.time() - t0 < 30 and not os.path.exists('${GO}'): time.sleep(0.02)
try: os.remove('${GO}')
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restore = L.__setClaudeBin(bin)
// the main's MCP stream (lanes-m1-delivery.test.ts): an offer into an open stream waits on `gate` while one is set: the offer is in flight
const open = new Set<string>(), offers: Array<{ sid: string; notif: any }> = []
let gate: Promise<boolean> | null = null
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  notifySession: async (sid: string, notif: any) => {
    if (!open.has(sid)) return false
    const ok = gate ? await gate : true
    if (ok) offers.push({ sid, notif })
    return ok
  },
  streamOpen: (sid: string) => open.has(sid), sendBot: async () => 1, joeyChatId: () => '1', createTopic: async () => 7001 } as any)
const procs: any[] = []
afterAll(() => {
  try { writeFileSync(GO, 'ok') } catch {}
  for (const p of procs) { try { p.kill('SIGKILL') } catch {} }
  L.__setClaudeBin(restore); delete process.env.LANES_FLOOD_CONTROL
})
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20) } return f() }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const M = () => L.__main()
const item = (id: string) => M().items(r => r.id === id)[0]
const state = (id: string) => item(id)?.state
const content = (id: string) => String(item(id)?.notif?.params?.content ?? '')
const joeyOb = (ev: string) => ((L.__events().get(ev)?.obligations ?? []) as any[]).find(o => o.kind === 'joey')
let np = 0
const P = () => `p-11516-${++np}`
type Gen = { pid: number; sid: string; proc: any; mcp: string }
/** a process that stands in for the main (lanes-m1-delivery.test.ts startMain); `stream` false: no MCP stream, every offer fails and its items stay queued */
async function startMain(stream = true): Promise<Gen> {
  const proc = Bun.spawn(['sleep', '600']); procs.push(proc)
  const sid = randomUUID()
  writeFileSync(join(dir, 'main-expected'), sid)
  const g = { pid: proc.pid, sid, proc, mcp: `mcp-${proc.pid}` }
  if (stream) { open.add(g.mcp); L.__noteMcpPid(g.mcp, g.pid) }
  const r = await L.__mainEvent({ event: 'SessionStart', pid: g.pid, session_id: sid, source: 'startup' })
  expect(r.accepted).toBe(true)
  await M().pump()
  return g
}
const hook = (g: Gen, event: string, o: object = {}) => L.__mainEvent({ event, pid: g.pid, session_id: g.sid, ...o })
async function endMain(g: Gen): Promise<void> {
  await hook(g, 'SessionEnd'); g.proc.kill('SIGKILL'); await g.proc.exited; open.delete(g.mcp); await M().tick()
}
/** Joey's Telegram message `id` in `chat` (server.ts dispatchInbound: event tg-<chat>-<id>), routed to the main; its M1 item */
async function joey(chat: string, id: number, text: string): Promise<string> {
  const meta = { chat_id: chat, message_id: String(id), user: 'joey_lab' }
  const d = await L.routeEvent({ id: `tg-${chat}-${id}`, source: 'telegram', from: 'joey', text, meta, verified: true,
    notif: { method: 'notifications/claude/channel', params: { content: text, meta } } } as any)
  expect(d.target).toBe('main')
  return M().items(r => r.event === `tg-${chat}-${id}`)[0].id
}
// what server.ts replaceQueuedEdit passes (onsen-edit.ts rewriteQueued, shortened: onsen-step2-lanes.test.ts)
const rw = (p: { content: string; meta: Record<string, string> }) => ({ content: `新：${p.content.length}`, meta: { ...p.meta, edited: 'true', edited_at: '2026-11-25T03:09:00.000Z' } })

test('(1) an edit during the offer of its message: not rewritten (false, the item keeps its text); then offered with that text; an item not being offered is rewritten', async () => {
  const g = await startMain()
  const k = offers.length
  const d = deferred<boolean>(); gate = d.promise
  const a = await joey('1', 801, '原文 A')                    // the main is idle: pump offers it now; the offer waits on the stream
  expect(state(a)).toBe('queued')                              // still queued while its offer is on its way
  expect(L.replaceQueuedMain('1', '801', rw)).toBe(false)      // in flight: the edit goes as a new message (server.ts)
  expect(content(a)).toBe('原文 A')
  expect(item(a).edited_in_queue).toBeUndefined()
  const b = await joey('1', 802, '原文 B')                    // reaches the queue meanwhile: one offer at a time, B is not being offered
  expect(state(b)).toBe('queued')
  expect(L.replaceQueuedMain('1', '802', rw)).toBe(true)
  expect(content(b)).toBe('新：4'); expect(item(b)).toMatchObject({ edited_in_queue: true })
  d.resolve(true); gate = null
  expect(await until(() => state(a) === 'offered')).toBe(true)
  expect(offers.length).toBe(k + 1)
  expect(offers.at(-1)!.notif.params.content).toBe('原文 A')    // what the main got is what the item holds
  expect(offers.at(-1)!.notif.params.meta.did).toContain(a)
  expect(content(a)).toBe('原文 A')
  expect(L.replaceQueuedMain('1', '801', rw)).toBe(false)      // offered: still a new message
  expect(state(b)).toBe('queued')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [a, b] }); await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
  expect(state(a)).toBe('done'); expect(state(b)).toBe('done')
  await endMain(g)
}, 30000)

test('(1) an offer that failed (no stream took it) leaves nothing in flight: the next edit rewrites the queued item', async () => {
  const g = await startMain()
  const d = deferred<boolean>(); gate = d.promise
  const a = await joey('1', 811, '原文 C')
  expect(L.replaceQueuedMain('1', '811', rw)).toBe(false)      // in flight
  d.resolve(false); gate = null
  expect(await until(() => item(a)?.last_no_wake === 'unreachable')).toBe(true)
  expect(state(a)).toBe('queued')
  expect(L.replaceQueuedMain('1', '811', rw)).toBe(true)       // `finally` took it out of the in-flight set
  expect(content(a)).toBe('新：4')
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [a] }); await hook(g, 'Stop', { prompt_id: p, phase: 'final' })
  expect(state(a)).toBe('done')
  await endMain(g)
}, 30000)

test('(2a) Telegram number 640 in the DM and in a group, both in one turn: a reply in the DM quoting 640 meets only the DM message\'s Joey line (and the other way)', async () => {
  const GROUP = '-1001234567890'
  const g = await startMain(false)
  const a = await joey('1', 640, 'DM 的 640'), b = await joey(GROUP, 640, '群組的 640')
  expect(L.__events().get('tg-1-640')).toMatchObject({ tg: { message_id: '640', chat_id: '1' } })        // events record their chat
  expect(L.__events().get(`tg-${GROUP}-640`)).toMatchObject({ tg: { message_id: '640', chat_id: GROUP } })
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids: [a, b] })
  expect(state(a)).toBe('bound'); expect(state(b)).toBe('bound')
  try {
    expect(L.mainReplyTier({ reply_to: '640', chat_id: '1' })).toBeNull()          // quoting Joey: an ordinary (ringing) answer
    L.mainReplied(null, 900, '640', '收到 DM 的', '1')
    expect(joeyOb('tg-1-640')).toMatchObject({ state: 'met', by: 'main', ref: '900' })
    expect(joeyOb(`tg-${GROUP}-640`).state).toBe('handed')                          // the group's 640 is still owed
    expect(L.__events().get(`tg-${GROUP}-640`)!.main_sends).toBeUndefined()
    expect(L.mainReplyTier({ reply_to: '640', chat_id: GROUP })).toBeNull()
    L.mainReplied(null, 901, '640', '收到群組的', GROUP)
    expect(joeyOb(`tg-${GROUP}-640`)).toMatchObject({ state: 'met', by: 'main', ref: '901' })
    expect(joeyOb('tg-1-640').ref).toBe('900')                                       // the DM's is not met again
    expect((L.__events().get('tg-1-640')!.main_sends as any[]).map(s => s.ref)).toEqual(['900'])
  } finally {
    await hook(g, 'Stop', { prompt_id: p, phase: 'final' }); await endMain(g)
  }
}, 30000)

test('(2b) a lane\'s hand-over of Joey\'s 578 and Joey\'s edit of 578 in one turn: one reply quoting 578 meets both Joey lines; the Stop check holds nothing', async () => {
  // a worker lane with a topic (lanes-golive-replyto.test.ts): Joey's 578, written in its topic, reaches the worker, which hands it to the main
  const wo = '[board][WO-511] 請 adam 整理清單'
  const w = await L.routeEvent({ id: 'mesh-11516-1', source: 'mesh', from: 'board', verified: true, text: wo, meta: {}, line: 'call', notif: { method: 'notifications/claude/channel', params: { content: wo, meta: {} } } } as any)
  expect(w).toMatchObject({ rule: 'mesh-board', target: 'lane' })
  expect(await until(() => !!L.__runTok(w.lane!))).toBe(true)
  writeFileSync(GO, 'ok'); expect(await until(() => !L.__runTok(w.lane!))).toBe(true); await sleep(40)
  const meta = { chat_id: '1', message_id: '578', user: 'joey', message_thread_id: '7001' }
  const orig = 'tg-1-578'
  const j = await L.routeEvent({ id: orig, source: 'telegram', from: 'joey', text: '把清單寫成 knowledge/x.md', meta, verified: true, message_thread_id: '7001',
    notif: { method: 'notifications/claude/channel', params: { content: '把清單寫成 knowledge/x.md', meta } } } as any)
  expect(j).toMatchObject({ rule: 'tg-worker-topic', lane: w.lane })
  expect(await until(() => !!L.__runTok(w.lane!))).toBe(true)
  expect(await L.callLaneTool(L.__runTok(w.lane!)!, 'handoff_main', { text: 'Joey 要寫 knowledge/x.md，我被擋，請主線寫並回他' })).toContain('handed to the main')
  writeFileSync(GO, 'ok'); expect(await until(() => !L.__runTok(w.lane!))).toBe(true); await sleep(40)
  expect(joeyOb(orig).state).toBe('handed')
  const ho = M().items(r => r.state !== 'done' && String(r.event) === orig)
  expect(ho.length).toBe(1); expect(ho[0].kind).toBe('handoff')
  expect(String(ho[0].notif.params.meta.message_id ?? '')).toBe('')                 // the hand-over item carries the lane's text, not Joey's message id
  // Joey edits 578 (onsen-edit.ts deliverEdit: the original was seen, so the edit goes as a new message, server.ts dispatchInbound); the router gives it to
  // the main (no topic on this one)
  const at = '2026-11-25T03:09:00.000Z'
  const em = { chat_id: '1', message_id: '578', user: 'joey', ts: at, edited: 'true', edited_at: at }
  const edit = `tg-1-578-edit-${Date.parse(at)}-1`
  const etext = '〔joey 改了他 03:08Z 那一則（tg:578）〕\n把清單寫成 knowledge/y.md'
  const e = await L.routeEvent({ id: edit, source: 'telegram', from: 'joey', text: etext, meta: em, verified: true,
    notif: { method: 'notifications/claude/channel', params: { content: etext, meta: em } } } as any)
  expect(e.target).toBe('main')
  expect(joeyOb(edit).state).toBe('handed')
  const g = await startMain(false)
  const dids = M().items(r => r.state === 'queued' && r.kind !== 'digest' && (String(r.event) === orig || String(r.event) === edit)).map(r => r.id)
  expect(dids.length).toBe(2)
  const p = P()
  await hook(g, 'UserPromptSubmit', { prompt_id: p, dids })
  for (const id of dids) expect(state(id)).toBe('bound')
  try {
    expect(L.mainReplyTier({ reply_to: '578', chat_id: '1' })).toBeNull()
    L.mainReplied(null, 579, '578', '寫好了（照你改過的 y.md）', '1')
    expect(joeyOb(edit)).toMatchObject({ state: 'met', by: 'main', ref: '579' })    // matched by its item (message_id 578)
    expect(joeyOb(orig)).toMatchObject({ state: 'met', by: 'main', ref: '579' })    // matched by its record (tg.message_id 578): before the fix it stayed owed
    const r = await hook(g, 'Stop', { prompt_id: p })
    expect(String(r.block ?? '')).not.toContain('還欠事沒交代')                       // nothing owed: no hold, no second answer
  } finally {
    await hook(g, 'Stop', { prompt_id: p, phase: 'final' }); await endMain(g)
  }
}, 30000)

// (3) server.ts, no test: the edit's lanes event id (`tg-<chat>-<id>-edit-<ms>-<counter>`) is built inline in dispatchInbound, which server.ts does not
// export; server.ts starts the whole daemon on import. The only way to drive it is the daemon harness (test-fixtures/tg-daemon.ts + tg-bot-api-mock.ts,
// as onsen-step2-daemon.test.ts) with lanes on, an Onsen stand-in with recording on, Joey's message delivered and seen, then two edited_message updates
// with the same edit_date, and the two event ids read from the lanes journal. Checked by reading: the counter is module-level (`let editEventSeq = 0`),
// incremented once per edit (`++editEventSeq` inside the edited_at branch), so two edits in one second get -1 and -2; a non-edit id is unchanged.
