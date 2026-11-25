// WO-164 phase 1 (Chiron's ticket): every item belongs to a thread with a fixed key and goes to that thread's owner. The router in this process (lanes.ts,
// role tg) with LANES_WAKE_DECIDE on for this agent, a stand-in statusOf, a live main (this process), a lane binary that answers at once. Chiron's acceptance:
//   1 the same ticket / schedule / mail conversation / incident / call thread, two items each → one thread, the second to the first's owner
//     (a schedule: two different reflex lanes, one thread; its lane is let go when its run ends)
//   2 a mail on a thread the main owns (lanes-wo164-batch.test.ts)
//   3 [WO-999] in the text with no ticket field does not join WO-999's thread (a thread_key_missing row says what the old reading would have done)
// and the Onsen half: the thread events (open / assign / item, per-agent dedupe), the start handshake, a conflict; detail.lanes[].thread.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { threadKeyOf, threadEvents, sentOf, refsOf, ticketOf, runOf, type KeyLinks } from './lanes-threads.ts'

const AGENT = 'wo164t'
process.env.LANES_WAKE_DECIDE = `someone-else,${AGENT}`
// the agent-inbox daemon's stand-in: it takes every offer to the main's inbox stream (M1 via 'inbox')
const offers: any[] = []
const inboxSrv = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url), body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  if (u.pathname === '/lanes/offer') { offers.push(body); return Response.json({ offered: true }) }
  return Response.json({ ok: true, text: 'ok' })
} })
process.env.LANES_INBOX_PORT = String(inboxSrv.port)
const L = await import('./lanes.ts?wo164') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-wo164-'))
process.env.LANES_DIR = dir
writeFileSync(join(dir, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
let member: string = 'idle'
const status = () => ({ state: member, detail: {} })
L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false,
  notifySession: async () => true, streamOpen: () => true,
  registryNames: () => ['chiron', 'eve'], sendBot: async () => 1, joeyChatId: () => '1828', mainStatus: status } as any)
L.__setMainConnected('mcp-main')
const meshed: any[] = []
L.__setMeshSend(async b => { meshed.push(b); return { msgId: 96000 + meshed.length, text: `sent to ${b.to}`, delivered: true } })
// a lane binary that answers like a successful claude run (after the seconds in <LANES_DIR>/lane-sleep: the lane's env is the lanes' own, not the test's)
const bin = join(dir, 'lane-ok.sh')
writeFileSync(bin, '#!/bin/sh\nsleep "$(cat "$LANES_DIR/lane-sleep" 2>/dev/null || echo 0)"\necho \'{"type":"result","subtype":"success","is_error":false,"result":"ok"}\'\n')
const laneSleep = (sec: number) => { if (sec) writeFileSync(join(dir, 'lane-sleep'), String(sec)); else rmSync(join(dir, 'lane-sleep'), { force: true }) }
chmodSync(bin, 0o755)
const realBin = L.__setClaudeBin(bin)
// the Onsen sink (server.ts gives the spool): every event recorded; GET /threads answers `onsenRows`
const told: any[] = []
let onsenRows: any[] = []
const sink = { record: (evs: any[]) => { told.push(...evs); return true }, fetch: async () => onsenRows, pending: () => 0 }
beforeAll(async () => { await L.setThreadSink(sink, { waitMs: 0 }) })
afterAll(() => { inboxSrv.stop(true); delete process.env.LANES_INBOX_PORT; L.__setMeshSend(null); L.__setClaudeBin(realBin); L.setThreadSink(null); delete process.env.LANES_WAKE_DECIDE })
const st = L.__lanesState()
const routing = (): any[] => { try { return readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const lanesLog = (): any[] => { try { return readFileSync(join(dir, 'lanes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const rowOf = (id: string) => routing().filter(r => r.event === id).at(-1)
const items = (id: string) => L.__main().items((r: any) => r.event === id)
const until = async (f: () => boolean, ms = 8000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await new Promise(r => setTimeout(r, 50)) } return f() }
let n = 0
function mesh(from: string, text: string, o: Record<string, unknown> = {}): any {
  n += 1
  return { id: `mesh-wo164-${n}`, source: 'mesh', from, text, verified: true, meta: { user: from }, notif: { method: 'notifications/claude/channel', params: { content: text, meta: { user: from } } },
    line: 'call', btcc_msg_id: String(80000 + n), ...o }
}
const pid = process.pid
const idle = async () => { await L.__mainEvent({ event: 'Stop', pid }) }
// ------------------------------------------------------------------ the pure half
const noLinks: KeyLinks = { callThread: () => undefined, replyThread: () => null, quotedThread: () => null, topicThread: () => null }
test('threadKeyOf: the kind\'s own field first; then the links; Joey\'s chat; a mail that starts a conversation; else the item itself', () => {
  expect(threadKeyOf({ id: 'e1', source: 'mesh', kind: 'peer_mail', refs: { conversation: '200301' } }, noLinks)).toEqual({ key_kind: 'mail', key: '200301', via: 'field' })
  expect(threadKeyOf({ id: 'e2', source: 'mesh', kind: 'scheduled', refs: { schedule: '42', run: '7001' } }, noLinks)).toEqual({ key_kind: 'schedule', key: '42', via: 'field' })
  expect(threadKeyOf({ id: 'e3', source: 'mesh', kind: 'board', refs: { ticket: 'WO-164' } }, noLinks)).toEqual({ key_kind: 'ticket', key: '164', via: 'field' })
  expect(threadKeyOf({ id: 'e4', source: 'mesh', kind: 'alert', refs: { incident: 'inc-9', alert: '1361' } }, noLinks)).toEqual({ key_kind: 'incident', key: 'inc-9', via: 'field' })
  // a field of another kind is not this kind's key (a call that names a ticket is still its call's)
  expect(threadKeyOf({ id: 'e5', source: 'mesh', kind: 'peer_call', refs: { ticket: '164' } }, noLinks)).toEqual({ key_kind: 'item', key: 'e5', via: 'own' })
  // a call's thread: ours (the link), another peer's (null: not this one's), new to us (the peer's id is the key)
  expect(threadKeyOf({ id: 'e6', source: 'mesh', kind: 'peer_call', thread: 'eve#t-aa01' }, { ...noLinks, callThread: () => 'eve#t-aa01' })).toEqual({ thread: 'eve#t-aa01', via: 'thread' })
  expect(threadKeyOf({ id: 'e7', source: 'mesh', kind: 'peer_call', thread: 'eve#t-aa02' }, noLinks)).toEqual({ key_kind: 'peer_call', key: 'eve#t-aa02', via: 'thread' })
  expect(threadKeyOf({ id: 'e8', source: 'mesh', kind: 'peer_call', thread: 'eve#t-aa03' }, { ...noLinks, callThread: () => null })).toEqual({ key_kind: 'item', key: 'e8', via: 'own' })
  // a reply: the thread of the item it quotes
  expect(threadKeyOf({ id: 'e9', source: 'mesh', kind: 'peer_mail', reply_to_id: '500', btcc_msg_id: '501' }, { ...noLinks, replyThread: () => 'x#t-01' })).toEqual({ thread: 'x#t-01', via: 'reply_to' })
  expect(threadKeyOf({ id: 'e10', source: 'mesh', kind: 'peer_mail', btcc_msg_id: '502' }, noLinks)).toEqual({ key_kind: 'mail', key: '502', via: 'msg_id' })
  // Joey: his chat, a topic, a quoted lane message
  expect(threadKeyOf({ id: 't1', source: 'telegram', kind: 'joey_tg', chat: '1828' }, noLinks)).toEqual({ key_kind: 'tg', key: 'tg:1828', via: 'tg' })
  expect(threadKeyOf({ id: 't2', source: 'telegram', kind: 'joey_tg', chat: '1828', topic: '77' }, noLinks)).toEqual({ key_kind: 'tg', key: 'tg:1828:77', via: 'tg' })
  expect(threadKeyOf({ id: 't3', source: 'telegram', kind: 'joey_tg', chat: '1828', reply_to_message_id: '9' }, { ...noLinks, quotedThread: () => 'a#t-9' })).toEqual({ thread: 'a#t-9', via: 'quoted' })
  // a board item with [WO-n] in its text and no field: its own (the text is never read)
  expect(threadKeyOf({ id: 'b1', source: 'mesh', kind: 'board' }, noLinks)).toEqual({ key_kind: 'item', key: 'b1', via: 'own' })
})
test('refs, tickets and runs are fields: kept to the known keys; the run is never read from a text', () => {
  expect(refsOf({ schedule: 42, run: '7001', ticket: 164, junk: 'x', conversation: '' })).toEqual({ schedule: '42', run: '7001', ticket: '164' })
  expect(refsOf(null)).toBeUndefined()
  expect(ticketOf('WO-12')).toBe('12'); expect(ticketOf(12)).toBe('12'); expect(ticketOf('twelve')).toBeNull()
  expect(runOf({ run: '7001' })).toBe('7001'); expect(runOf({ run_id: '6910' })).toBe('6910'); expect(runOf(undefined, '61')).toBe('61'); expect(runOf(undefined, undefined)).toBeNull()
})
test('threadEvents: the first carries the key; then only what changed (owner, item, state), each with its own dedupe', () => {
  const v = { thread: 'a#t-1', key_kind: 'ticket' as const, key: '164', title: 'WO-164', owner: 'main', state: 'open' as const, last_item: { id: 'e1', kind: 'board', at: '2026-11-25T16:00:00.000Z', preview: '球到你手上' } }
  const a = threadEvents(v, undefined, { at: 't0', epoch: 'ep' })
  expect(a.events).toEqual([{ thread: 'a#t-1', event: 'open', at: 't0', dedupe: 'ep:a#t-1:1', key_kind: 'ticket', key: '164', title: 'WO-164', owner: 'main', item: { id: 'e1', kind: 'board', at: '2026-11-25T16:00:00.000Z', text: '球到你手上' } }])
  expect(threadEvents(v, a.sent, { at: 't1', epoch: 'ep' }).events).toEqual([])
  const b = threadEvents({ ...v, owner: 'x.reflex.1', last_item: { ...v.last_item, id: 'e2' } }, a.sent, { at: 't1', epoch: 'ep' })
  expect(b.events.map(e => [e.event, e.dedupe, e.owner])).toEqual([['transfer', 'ep:a#t-1:2', 'x.reflex.1'], ['item', 'ep:a#t-1:3', undefined]])
  const c = threadEvents({ ...v, owner: null, state: 'closed', last_item: { ...v.last_item, id: 'e2' } }, b.sent, { at: 't2', epoch: 'ep' })
  expect(c.events.map(e => e.event)).toEqual(['assign', 'close'])
  expect(threadEvents({ ...v, owner: null, state: 'open', last_item: { ...v.last_item, id: 'e3' } }, c.sent, { at: 't3', epoch: 'ep' }).events.map(e => e.event)).toEqual(['reopen', 'item'])
  expect(threadEvents({ ...v, state: 'waiting_peer' }, undefined, { at: 't', epoch: 'ep' }).events.map(e => e.event)).toEqual(['open', 'wait'])
  expect(threadEvents({ ...v, state: 'closed' }, undefined, { at: 't', epoch: 'ep' }).events[0].event).toBe('close')
  expect(sentOf({ owner: null, state: 'closed', last_item: { id: 'e9' } }, 4)).toEqual({ owner: null, state: 'closed', item: 'e9', n: 4 })
})

// ------------------------------------------------------------------ the router
const threadOf = (id: string) => { const t = rowOf(id)?.thread; return t ? st.threads[t] : undefined }
test('acceptance 1, a ticket: two board items with refs.ticket are one thread; the second goes to the first\'s owner (topics off: the main)', async () => {
  await idle()
  const a = mesh('board', '[board][WO-500] 球到你手上', { item_kind: 'board', refs: { ticket: '500' } })
  const b = mesh('board', '[board][WO-500] 對方留言了', { item_kind: 'board', refs: { ticket: 500 } })
  const da = await L.routeEvent(a)
  expect(da).toMatchObject({ target: 'main' })
  const t = threadOf(a.id)!
  expect(t).toMatchObject({ key_kind: 'ticket', key: '500', lane: 'main', state: 'open' })
  const db = await L.routeEvent(b)
  expect(db).toMatchObject({ target: 'main', rule: 'wake:owner' })
  expect(rowOf(b.id).thread).toBe(t.id)
  expect(t.last_item?.id).toBe(b.id)
  expect(L.__threadByKey('ticket', '500')?.id).toBe(t.id)
})
test('acceptance 1, a schedule: two runs are two reflex lanes on one thread; the thread lets each lane go when its run ends', async () => {
  const a = mesh('scheduler', '[scheduled][wo164-check][run:7001][P3][routine] 查一下', { item_kind: 'scheduled', refs: { schedule: '88', run: '7001' }, meta: { user: 'scheduler', run_id: '7001' } })
  const da = await L.routeEvent(a)
  expect(da).toMatchObject({ target: 'lane', rule: 'wake:scheduled' })
  const t = threadOf(a.id)!
  expect(t).toMatchObject({ key_kind: 'schedule', key: '88' })
  expect(st.lanes[da.lane!].thread).toBe(t.id)
  expect(await until(() => st.threads[t.id].lane === null)).toBe(true)                         // the run ended: released
  expect(lanesLog().some(r => r.kind === 'thread_released' && r.thread === t.id)).toBe(true)
  const b = mesh('scheduler', '[scheduled][wo164-check][run:7002][P3][routine] 查一下', { item_kind: 'scheduled', refs: { schedule: '88', run: '7002' }, meta: { user: 'scheduler', run_id: '7002' } })
  const db = await L.routeEvent(b)
  expect(db).toMatchObject({ target: 'lane', rule: 'wake:scheduled' })
  expect(db.lane).not.toBe(da.lane)                                                            // a lane (and a session) of its own
  expect(st.lanes[db.lane!].thread).toBe(t.id)
  expect(st.lanes[db.lane!].session_id).not.toBe(st.lanes[da.lane!].session_id)
  expect(rowOf(b.id).thread).toBe(t.id)
  expect(await until(() => st.threads[t.id].lane === null)).toBe(true)
})
test('acceptance 1, a schedule run while the previous one is still running: a lane of its own on the same thread, never queued behind it', async () => {
  laneSleep(2)
  try {
    const a = mesh('scheduler', '[scheduled][wo164-slow][run:7101][P3][routine] 慢的', { item_kind: 'scheduled', refs: { schedule: '89', run: '7101' }, meta: { user: 'scheduler', run_id: '7101' } })
    const da = await L.routeEvent(a)
    expect(await until(() => L.runningLanes().some(r => r.id === da.lane))).toBe(true)
    const b = mesh('scheduler', '[scheduled][wo164-slow][run:7102][P3][routine] 慢的', { item_kind: 'scheduled', refs: { schedule: '89', run: '7102' }, meta: { user: 'scheduler', run_id: '7102' } })
    expect(L.runningLanes().some(r => r.id === da.lane)).toBe(true)                            // the first run is still in flight
    const db = await L.routeEvent(b)
    expect(db.lane).not.toBe(da.lane)
    expect(st.lanes[db.lane!].thread).toBe(st.lanes[da.lane!].thread)
    expect(await until(() => L.runningLanes().filter(r => r.thread === st.lanes[da.lane!].thread).length === 2)).toBe(true)   // two runs, one thread
    // point 6: detail.lanes[] carries the thread each run is on
    expect(await until(() => L.runningLanes().filter(r => r.thread === st.lanes[da.lane!].thread).length >= 1)).toBe(true)
    expect(L.runningLanes().find(r => r.id === da.lane)?.thread).toBe(st.lanes[da.lane!].thread)
    await until(() => !L.runningLanes().length, 10000)
  } finally { laneSleep(0) }
})
test('Chiron 16:50Z (7): an item of the same refs.run while that run\'s lane still runs goes to it (behind its run); once it has ended, a new reflex lane', async () => {
  laneSleep(2)
  try {
    const a = mesh('scheduler', '[scheduled][wo164-nudge][run:7401][P3][routine] 查一下', { item_kind: 'scheduled', refs: { schedule: '90', run: '7401', run_id: '7401' }, meta: { user: 'scheduler', run_id: '7401' } })
    const da = await L.routeEvent(a)
    expect(await until(() => L.runningLanes().some(r => r.id === da.lane))).toBe(true)
    const nudge = mesh('scheduler', '[scheduled][wo164-nudge][run:7401][stall-nudge] 這個 run 送到了但一直沒有 ack', { item_kind: 'scheduled', refs: { schedule: '90', run: '7401', run_id: '7401' }, meta: { user: 'scheduler', run_id: '7401' } })
    const dn = await L.routeEvent(nudge)
    expect(dn).toMatchObject({ target: 'lane', lane: da.lane, rule: 'wake:owner' })
    expect(dn.note ?? '').toContain(`run 7401 is still ${da.lane}'s`)
    expect(dn.note ?? '').toContain('queued behind the running run')
    expect(rowOf(nudge.id).thread).toBe(rowOf(a.id).thread)
    // another run of the same schedule meanwhile: a lane of its own (the schedule's owner is not read for the next run)
    const b = mesh('scheduler', '[scheduled][wo164-nudge][run:7402][P3][routine] 查一下', { item_kind: 'scheduled', refs: { schedule: '90', run: '7402', run_id: '7402' }, meta: { user: 'scheduler', run_id: '7402' } })
    const db = await L.routeEvent(b)
    expect(db.rule).toBe('wake:scheduled')
    expect(db.lane).not.toBe(da.lane)
    laneSleep(0)
    expect(await until(() => !L.runningLanes().length, 15000)).toBe(true)
    await new Promise(r => setTimeout(r, 300))
    expect(await until(() => !L.runningLanes().length, 15000)).toBe(true)
    // run 7401 has ended (its run and the nudge behind it): a later item of it opens a new reflex lane
    const late = mesh('scheduler', '[scheduled][wo164-nudge][run:7401][stall-nudge] 還是沒有 ack', { item_kind: 'scheduled', refs: { schedule: '90', run: '7401', run_id: '7401' }, meta: { user: 'scheduler', run_id: '7401' } })
    const dl = await L.routeEvent(late)
    expect(dl.rule).toBe('wake:scheduled')
    expect(dl.lane).not.toBe(da.lane)
    expect(dl.lane).not.toBe(db.lane)
    await until(() => !L.runningLanes().length, 15000)
  } finally { laneSleep(0) }
})
test('Chiron 16:50Z (9): a mail\'s key is refs.conversation, always: a lane\'s new mail opens its conversation (the lane owns it); answers carrying it go to that lane', async () => {
  const lane = `${AGENT}.reflex.99`, thread = `${AGENT}#t-990099`
  st.lanes[lane] = { id: lane, kind: 'reflex', n: 99, session_id: 's99', thread, status: 'idle', created: '', last: new Date().toISOString(), transcript: join(dir, 'l99.jsonl'), runs: 1, tokens_in: 0, tokens_out: 0 } as any
  st.threads[thread] = { id: thread, lane, peer: null, hops: 0, tokens: 0, created: '', last: '' } as any
  const ev: any = mesh('chiron', '週報的格式？')
  L.__putQueue({ ev, lane, state: 'leased', lease_until: 0, attempts: 1, priority: 1, enqueued: '' })
  const tok = { runId: `${lane}.r1`, lane, evId: ev.id, closers: [], critical: false, trigger: 'peer', cls: 'peer', escalated: false, pushed: false }
  const k = meshed.length
  await L.callLaneTool(tok as any, 'reply_agent', { line: 'mail', to: 'chiron', title: '週報格式', ask: '確認用表格', text: '要改成表格嗎？' })
  const sent = meshed.slice(k).find(m => m.send?.line === 'mail' || m.line === 'mail') ?? meshed[k]
  expect(sent).toBeTruthy()
  const id = String(96000 + meshed.length)
  const t = L.__threadByKey('mail', id)
  expect(t).toMatchObject({ key_kind: 'mail', key: id, lane })
  // chiron answers: its conversation is that mail's id (and its reply_to points elsewhere: the field decides)
  const r = mesh('chiron', '【信】Re: 週報格式\n好，用表格', { item_kind: 'peer_mail', line: 'mail', refs: { conversation: id }, reply_to_id: '80001' })
  const d = await L.routeEvent(r)
  expect(d).toMatchObject({ target: 'lane', lane, rule: 'wake:owner' })
  expect(rowOf(r.id).thread).toBe(t!.id)
  // a reply to that answer (mailbox_reply binds nothing locally): the conversation still names the same thread
  const r2 = mesh('chiron', '【信】Re: Re: 週報格式\n附上範本', { item_kind: 'peer_mail', line: 'mail', refs: { conversation: id } })
  expect((await L.routeEvent(r2)).lane).toBe(lane)
  expect(rowOf(r2.id).thread).toBe(t!.id)
  await until(() => !L.runningLanes().length, 10000)
})
test('acceptance 1, a mail conversation: two mails with refs.conversation are one thread, owned by the mail lane; the second goes there by the owner rule', async () => {
  const a = mesh('eve', '【信】週報格式\n要改成表格', { item_kind: 'peer_mail', line: 'mail', refs: { conversation: '200401' } })
  const da = await L.routeEvent(a)
  expect(da).toMatchObject({ target: 'lane', rule: 'wake:mail' })
  const t = threadOf(a.id)!
  expect(t).toMatchObject({ key_kind: 'mail', key: '200401', lane: da.lane })
  expect(st.lanes[da.lane!].kind).toBe('mail')
  const b = mesh('eve', '【信】Re: 週報格式\n補一欄', { item_kind: 'peer_mail', line: 'mail', refs: { conversation: '200401' }, reply_to_id: String(80000 + n) })
  const db = await L.routeEvent(b)
  expect(db).toMatchObject({ target: 'lane', lane: da.lane, rule: 'wake:owner' })
  expect(rowOf(b.id).thread).toBe(t.id)
})
test('acceptance 1, an incident: two alerts with refs.incident are one thread; the second is merged into the first\'s lane', async () => {
  const a = mesh('alert-dispatcher', '【警報 warning】alert 1361：netdata / bt-xboard / cpu = 91', { item_kind: 'alert', refs: { incident: 'inc-77', alert: '1361' } })
  const da = await L.routeEvent(a)
  expect(da).toMatchObject({ target: 'lane' })
  const t = threadOf(a.id)!
  expect(t).toMatchObject({ key_kind: 'incident', key: 'inc-77', lane: da.lane })
  const b = mesh('alert-dispatcher', '【警報 warning】alert 1362：netdata / other-host / disk = 95', { item_kind: 'alert', refs: { incident: 'inc-77', alert: '1362' } })
  const db = await L.routeEvent(b)
  expect(db).toMatchObject({ target: 'lane', lane: da.lane })
  expect(db.rule).toMatch(/^wake:owner\/incident-merge|^wake:owner$/)
  expect(rowOf(b.id).thread).toBe(t.id)
  // the same host with no incident field: the text is not read for an incident (a thread of its own; the row says what the old reading would have merged)
  const c = mesh('alert-dispatcher', '【警報 warning】alert 1363：netdata / bt-xboard / mem = 97', { item_kind: 'alert', refs: { alert: '1363' } })
  await L.routeEvent(c)
  expect(rowOf(c.id).thread).not.toBe(t.id)
  await until(() => !L.runningLanes().length, 10000)
})
test('acceptance 1, an incident sent by someone who is not the alert dispatcher (the lab sends as itself): the second goes to the first\'s lane by the owner', async () => {
  laneSleep(1)
  try {
    const a = mesh('eve', '[P2] mock-api 慢', { item_kind: 'alert', refs: { incident: 'lab#1' } })
    const da = await L.routeEvent(a)
    expect(da.target).toBe('lane')
    const t = threadOf(a.id)!
    expect(t).toMatchObject({ key_kind: 'incident', key: 'lab#1', lane: da.lane })
    const b = mesh('eve', '[P2] mock-api 還是慢', { item_kind: 'alert', refs: { incident: 'lab#1' } })
    const db = await L.routeEvent(b)
    expect(db).toMatchObject({ target: 'lane', lane: da.lane, rule: 'wake:owner' })
    expect(db.note ?? '').toContain(`belongs to ${da.lane}`)
    expect(rowOf(b.id).thread).toBe(t.id)
    await until(() => !L.runningLanes().length, 10000)
  } finally { laneSleep(0) }
})
test('acceptance 1, a call thread: two calls on eve\'s thread are one thread; the second goes to the first\'s lane', async () => {
  const a = mesh('eve', '維護幾點？', { thread: 'eve#t-c0ffee', hop: 1 })
  const da = await L.routeEvent(a)
  expect(da).toMatchObject({ target: 'lane', rule: 'wake:peer-call' })
  expect(st.threads['eve#t-c0ffee']).toMatchObject({ key_kind: 'peer_call', key: 'eve#t-c0ffee', lane: da.lane })
  const b = mesh('eve', '還有，幾點結束？', { thread: 'eve#t-c0ffee', hop: 3 })
  const db = await L.routeEvent(b)
  expect(db).toMatchObject({ target: 'lane', lane: da.lane, rule: 'wake:owner' })
  expect(rowOf(b.id).thread).toBe('eve#t-c0ffee')
  await until(() => !L.runningLanes().length, 10000)
})
test('acceptance 3: [WO-999] in the text with no ticket field does not join WO-999\'s thread; a thread_key_missing row says what the old reading did', async () => {
  const a = mesh('board', '[board][WO-999] 第一則（有欄位）', { item_kind: 'board', refs: { ticket: '999' } })
  await L.routeEvent(a)
  const t = L.__threadByKey('ticket', '999')!
  expect(t).toBeTruthy()
  const b = mesh('board', '[board][WO-999] 第二則（沒有欄位）', { item_kind: 'board' })
  const d = await L.routeEvent(b)
  expect(rowOf(b.id).thread).not.toBe(t.id)
  expect(threadOf(b.id)).toMatchObject({ key_kind: 'item', key: b.id })
  expect(d.note ?? '').toContain('no ticket field')
  const miss = lanesLog().filter(r => r.kind === 'thread_key_missing' && r.event === b.id)
  expect(miss.length).toBe(1)
  expect(miss[0]).toMatchObject({ sender: 'board', item_kind: 'board', field: 'ticket', now: `item:${b.id}` })
  expect(miss[0].old).toContain('WO-999')
  // a scheduled head with a run and no run field: the run is not read from the text (the row says so)
  const s = mesh('scheduler', '[scheduled][nofield][run:7301][P3][routine] 沒有欄位', { item_kind: 'scheduled' })
  await L.routeEvent(s)
  expect(lanesLog().find(r => r.kind === 'thread_key_missing' && r.event === s.id)).toMatchObject({ field: 'run', old: expect.stringContaining('7301') })
  await until(() => !L.runningLanes().length, 10000)
})
test('Onsen: every keyed thread was opened once with its key, then only changes; dedupes unique; owners are what the threads say', () => {
  expect(told.length).toBeGreaterThan(0)
  const dd = told.map(e => e.dedupe)
  expect(new Set(dd).size).toBe(dd.length)
  const opens = told.filter(e => e.event === 'open' || (e.key_kind && e.event === 'close'))
  for (const t of Object.values(st.threads) as any[]) {
    if (!t.key_kind || t.alias_of) continue
    const mine = told.filter(e => e.thread === t.id)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine[0]).toMatchObject({ key_kind: t.key_kind, key: t.key })                    // the first event carries the key
    expect(opens.filter(e => e.thread === t.id).length).toBe(1)
    // the last owner told is the owner now
    const owners = mine.filter(e => 'owner' in e)
    const lastOwner = owners.at(-1)?.owner ?? null
    const l = t.lane === 'main' ? 'main' : t.lane && st.lanes[t.lane]?.status !== 'closed' ? t.lane : null
    expect(lastOwner).toBe(l)
  }
  const sched = L.__threadByKey('schedule', '88')!
  const evs = told.filter(e => e.thread === sched.id).map(e => e.event)
  expect(evs[0]).toBe('open')
  expect(evs.filter(e => e === 'assign').length).toBeGreaterThanOrEqual(2)                 // released after each run (owner null), then the next run's lane
})
test('the start handshake: a thread Onsen has and this daemon does not is taken in; one Onsen holds differently is told again', async () => {
  const mine = L.__threadByKey('ticket', '500')!
  onsenRows = [
    { thread: `${AGENT}#t-0nsen1`, key_kind: 'ticket', key: '777', title: 'WO-777', owner: 'main', state: 'open', last_item: { id: 'x1', kind: 'board', at: '2026-11-25T10:00:00Z', preview: 'p' }, created_at: '2026-11-25T10:00:00Z', updated_at: '2026-11-25T10:00:00Z' },
    { thread: mine.id, key_kind: 'ticket', key: '500', owner: null, state: 'closed', last_item: null, created_at: '2026-11-25T10:00:00Z', updated_at: '2026-11-25T10:00:00Z' },
  ]
  const k = told.length
  await L.setThreadSink(sink, { waitMs: 0 })
  expect(st.threads[`${AGENT}#t-0nsen1`]).toMatchObject({ key_kind: 'ticket', key: '777', lane: 'main', state: 'open' })
  expect(L.__threadByKey('ticket', '777')?.id).toBe(`${AGENT}#t-0nsen1`)
  const fix = told.slice(k).filter(e => e.thread === mine.id).map(e => e.event)
  expect(fix).toEqual(['reopen', 'assign', 'item'])                                        // Onsen said closed, nobody, no item: corrected
  expect(told.slice(k).some(e => e.thread === `${AGENT}#t-0nsen1`)).toBe(false)              // what Onsen holds already is not sent again
  expect(lanesLog().some(r => r.kind === 'thread_handshake' && r.taken_in === 1)).toBe(true)
  expect(st.thread_sync_at).toBeTruthy()
})
test('a conflict: Onsen holds another open thread on the key; this daemon\'s thread joins it and its events follow there', () => {
  const t = L.__threadByKey('ticket', '999')!
  const k = told.length
  L.threadConflict({ thread: t.id, event: 'open', at: '', dedupe: 'x', key_kind: 'ticket', key: '999' } as any, { thread: `${AGENT}#t-0nsen2`, owner: null, state: 'open' })
  expect(st.threads[t.id].alias_of).toBe(`${AGENT}#t-0nsen2`)
  expect(L.__threadByKey('ticket', '999')?.id).toBe(`${AGENT}#t-0nsen2`)
  expect(told.slice(k).filter(e => e.thread === `${AGENT}#t-0nsen2`).map(e => e.event)).toContain('assign')
  expect(lanesLog().some(r => r.kind === 'thread_conflict' && r.onsen_thread === `${AGENT}#t-0nsen2`)).toBe(true)
})
test('switch off for the agent: no thread keys (the old rules; nothing told to Onsen)', async () => {
  process.env.LANES_WAKE_DECIDE = 'someone-else'
  try {
    expect(L.threadKeysOn()).toBe(false)
    const k = told.length
    const b = mesh('board', '[board][WO-501] 球到你手上', { refs: { ticket: '501' } })
    await L.routeEvent(b)
    expect(rowOf(b.id).decided_by).toBe('old')
    expect(L.__threadByKey('ticket', '501')).toBeNull()
    expect(told.length).toBe(k)
    expect(L.runningLanes().every(r => r.thread === undefined)).toBe(true)
  } finally { process.env.LANES_WAKE_DECIDE = `someone-else,${AGENT}` }
})
