// WO-164 titles (Chiron 17:18Z, 「串的標題照串鍵取，不取第一則的全文」): a schedule thread's title was its first run's whole line
// ([scheduled][wo164-acc][run:7170431][P3]…, lab-relay /status 17:13:45Z), and every later run and Onsen's open threads showed it. Titles now come from the
// key: schedule 「排程 <名字>」, ticket 「WO-<n>」 / 「WO-<n> <title>」, alert 「事故 <host>」, mail the first mail's title, call 「<對方>：<第一句前 30 字>」,
// Joey 「Joey 私訊」 (「Joey 私訊／<話題名>」 in a topic); anything else keeps the first line of its first item. Set when the thread opens; the open threads of a
// state file from before are retitled at start, and Onsen gets the new title as an ordinary change (the first event of the change carries it).
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { threadTitle, threadEvents, scheduleNameOf, boardTitleOf, mailTitleOf, firstSentence, hostOf, TITLE_V } from './lanes-threads.ts'

// ------------------------------------------------------------------ the pure half: one title per kind
test('schedule: 「排程 <名字>」, the name in the header\'s second square bracket (every run and its stall-nudge the same); an empty tag: the schedule id', () => {
  expect(threadTitle('schedule', '6470431', { kind: 'scheduled', text: '[scheduled][wo164-acc][run:7170431][P3][routine] WO-164 驗收 排程第一次。這是測試台的測試件：讀到就結束' })).toBe('排程 wo164-acc')
  expect(threadTitle('schedule', '6470431', { kind: 'scheduled', text: '[scheduled][wo164-acc][run:7370431][stall-nudge] 這個 run 送到了但一直沒有 ack' })).toBe('排程 wo164-acc')
  expect(threadTitle('schedule', '30', { kind: 'scheduled', text: '[scheduled][][run:4360][P2][ops-check][high-frequency] check backorder' })).toBe('排程 #30')
  expect(scheduleNameOf('  [scheduled][tempox-backorder-weekly][run:42][P1][business-followup] check')).toBe('tempox-backorder-weekly')
  expect(scheduleNameOf('[board][WO-1] x')).toBeNull()
})
test('ticket: 「WO-<n>」, with the title the board\'s item carries (「<why>：<title>」 after [board][WO-n] and an [OP-…]); another ticket\'s head adds nothing', () => {
  expect(threadTitle('ticket', '164', { kind: 'board', text: '[board][WO-164] 新指派給你：每一則都屬於某一串、照串的負責人送\n提單 chiron → 指派 sonn｜狀態 in_progress' })).toBe('WO-164 每一則都屬於某一串、照串的負責人送')
  expect(threadTitle('ticket', '164', { kind: 'board', text: '[board][WO-164][OP-3 戰情：室] 對方做完了，等你驗收：串的標題' })).toBe('WO-164 串的標題')
  expect(threadTitle('ticket', '500', { kind: 'board', text: '[board][WO-500] 球到你手上' })).toBe('WO-500')
  expect(threadTitle('ticket', '500', { kind: 'board', text: '[board][WO-501] 球回到你手上：別張' })).toBe('WO-500')
  expect(threadTitle('ticket', '7', { kind: 'peer_call', text: '幫我看一下 WO-7' })).toBe('WO-7')
  expect(boardTitleOf('[board][WO-9] 卡住了，在等你補資料或做決定：DNS 切換', '9')).toBe('DNS 切換')
})
test('alert: 「事故 <host>」, the part of refs.incident before \'#\' (<host>#<first alert id>)', () => {
  expect(threadTitle('incident', 'lab-host#70431', { kind: 'alert', text: '【警報 warning】alert 70431：netdata / lab-host / cpu = 91' })).toBe('事故 lab-host')
  expect(threadTitle('incident', 'netdata/cpu.usage#1384', { kind: 'alert' })).toBe('事故 netdata/cpu.usage')
  expect(hostOf('drill-wo164-other#1386')).toBe('drill-wo164-other')
  expect(hostOf('no-id')).toBe('no-id')
})
test('mail: the first mail\'s title: its own field first, else the pushed head without 【信】 / 【回信】', () => {
  expect(threadTitle('mail', '200401', { kind: 'peer_mail', text: '【信】週報格式\n要你：確認用表格\n要改成表格\n（期限 18:00。#200401）' })).toBe('週報格式')
  expect(threadTitle('mail', '200402', { kind: 'peer_mail', text: '【回信】Re: 週報格式\n好' })).toBe('Re: 週報格式')
  expect(threadTitle('mail', '200403', { kind: 'peer_mail', title: 'WO-164 指派給你：串鍵', text: '【信】別的\n…' })).toBe('WO-164 指派給你：串鍵')
  expect(threadTitle('mail', '200404', { kind: 'peer_mail', text: '沒有記號的推送' })).toBe('沒有記號的推送')
  expect(mailTitleOf({ text: '' })).toBe('')
})
test('call: 「<對方>：<第一句前 30 字>」 (full-width colon; the sentence ends at 。！？!? or the line)', () => {
  expect(threadTitle('peer_call', 'chiron#t-1a2b', { kind: 'peer_call', from: 'chiron', text: 'WO-164 的標題改好了嗎？我要驗。' })).toBe('chiron：WO-164 的標題改好了嗎')
  expect(threadTitle('peer_call', 'eve#t-c0ffee', { kind: 'peer_call', from: 'eve', text: '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十多出來的字，後面' })).toBe('eve：一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十')
  expect(firstSentence('Deploy 1.57.1 now. Then tell me')).toBe('Deploy 1.57.1 now')
  expect(firstSentence('第一行\n第二行')).toBe('第一行')
  // a call that is a thread of its own (no thread field) is still a call
  expect(threadTitle('item', 'mesh-1', { kind: 'peer_call', from: 'eve', text: '維護幾點？' })).toBe('eve：維護幾點')
})
test('Joey: 「Joey 私訊」; in a topic of his DM 「Joey 私訊／<話題名>」 (the id when the name is not known); a group chat keeps the first line', () => {
  expect(threadTitle('tg', 'tg:1828', { kind: 'joey_tg', from: 'joey', text: '在嗎' })).toBe('Joey 私訊')
  expect(threadTitle('tg', 'tg:1828:77', { kind: 'joey_tg', text: '這個呢', topic_name: 'Onsen 設計' })).toBe('Joey 私訊／Onsen 設計')
  expect(threadTitle('tg', 'tg:1828:77', { kind: 'joey_tg', text: '這個呢' })).toBe('Joey 私訊／#77')
  expect(threadTitle('tg', 'tg:-1001234', { kind: 'joey_tg', text: '群組裡的一句\n第二行' })).toBe('群組裡的一句')
})
test('anything else (a thread of its own) keeps the current title: the first line of its first item, 80 characters', () => {
  const long = 'x'.repeat(100)
  expect(threadTitle('item', 'mesh-9', { kind: 'board', text: '[board][WO-999] 第二則（沒有欄位）\n內文' })).toBe('[board][WO-999] 第二則（沒有欄位）')
  expect(threadTitle('item', 'mesh-9', { kind: 'other', text: `\n${long}` })).toBe('x'.repeat(80))
})
test('threadEvents: a new title is an ordinary change: the first event of the change carries it, else the event that keeps the state; closed / unknown: nothing', () => {
  const v = { thread: 'a#t-1', key_kind: 'schedule' as const, key: '6470431', title: '排程 wo164-acc', owner: null, state: 'open' as const, last_item: { id: 'e1', kind: 'scheduled', at: 't', preview: 'p' } }
  const sent = { owner: null, state: 'open' as const, item: 'e1', n: 3, title: '[scheduled][wo164-acc][run:7170431][P3][routine] WO-164 驗收' }
  const a = threadEvents(v, sent, { at: 't1', epoch: 'ep' })
  expect(a.events).toEqual([{ thread: 'a#t-1', event: 'open', at: 't1', dedupe: 'ep:a#t-1:4', title: '排程 wo164-acc' }])
  expect(a.sent.title).toBe('排程 wo164-acc')
  expect(threadEvents(v, a.sent, { at: 't2', epoch: 'ep' }).events).toEqual([])              // told once
  const b = threadEvents({ ...v, owner: 'x.reflex.2', last_item: { ...v.last_item, id: 'e2' } }, sent, { at: 't1', epoch: 'ep' })
  expect(b.events.map(e => [e.event, e.title])).toEqual([['assign', '排程 wo164-acc'], ['item', undefined]])
  expect(threadEvents({ ...v, state: 'waiting_peer' }, { ...sent, state: 'waiting_peer' }, { at: 't', epoch: 'ep' }).events.map(e => [e.event, e.title])).toEqual([['wait', '排程 wo164-acc']])
  expect(threadEvents({ ...v, state: 'snoozed', snooze_until: 'z' }, { ...sent, state: 'snoozed' }, { at: 't', epoch: 'ep' }).events.map(e => [e.event, e.title, e.snooze_until])).toEqual([['snooze', '排程 wo164-acc', 'z']])
  expect(threadEvents({ ...v, state: 'closed' }, { ...sent, state: 'closed' }, { at: 't', epoch: 'ep' }).events).toEqual([])
  const { title: _t, ...noTitle } = sent
  expect(threadEvents(v, noTitle, { at: 't', epoch: 'ep' }).events).toEqual([])             // a state file from before: not compared
  expect(threadEvents(v, undefined, { at: 't', epoch: 'ep' }).sent.title).toBe('排程 wo164-acc')
})

// ------------------------------------------------------------------ the router: the title is set when the thread opens, and Onsen's first event carries it
const AGENT = 'v1571t'
process.env.LANES_WAKE_DECIDE = AGENT
const inboxSrv = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url)
  if (u.pathname === '/lanes/offer') return Response.json({ offered: true })
  return Response.json({ ok: true, text: 'ok' })
} })
process.env.LANES_INBOX_PORT = String(inboxSrv.port)
const L = await import('./lanes.ts?v1571-titles') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'v1571-titles-'))
process.env.LANES_DIR = dir
writeFileSync(join(dir, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, notifySession: async () => true, streamOpen: () => true,
  registryNames: () => ['chiron', 'eve'], sendBot: async () => 1, joeyChatId: () => '1828', mainStatus: () => ({ state: 'idle', detail: {} }) } as any)
L.__setMainConnected('mcp-main')
L.__setMeshSend(async b => ({ msgId: 97001, text: `sent to ${b.to}`, delivered: true }))
const bin = join(dir, 'lane-ok.sh')
writeFileSync(bin, '#!/bin/sh\necho \'{"type":"result","subtype":"success","is_error":false,"result":"ok"}\'\n')
chmodSync(bin, 0o755)
const realBin = L.__setClaudeBin(bin)
const told: any[] = []
const sink = { record: (evs: any[]) => { told.push(...evs); return true }, fetch: async () => [] as any[], pending: () => 0 }
beforeAll(async () => { await L.setThreadSink(sink, { waitMs: 0 }) })
const st = L.__lanesState()
const routing = (): any[] => { try { return readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const threadOf = (id: string) => { const t = routing().filter(r => r.event === id).at(-1)?.thread; return t ? st.threads[t] : undefined }
const opened = (thread: string) => told.find(e => e.thread === thread && e.key_kind)
const until = async (f: () => boolean, ms = 8000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await new Promise(r => setTimeout(r, 50)) } return f() }
let n = 0
function mesh(from: string, text: string, o: Record<string, unknown> = {}): any {
  n += 1
  return { id: `mesh-v1571-${n}`, source: 'mesh', from, text, verified: true, meta: { user: from }, notif: { method: 'notifications/claude/channel', params: { content: text, meta: { user: from } } },
    line: 'call', btcc_msg_id: String(81000 + n), ...o }
}
const pid = process.pid
afterAll(() => { inboxSrv.stop(true); delete process.env.LANES_INBOX_PORT; L.__setMeshSend(null); L.__setClaudeBin(realBin); L.setThreadSink(null); delete process.env.LANES_WAKE_DECIDE
  try { rmSync(dir, { recursive: true, force: true }) } catch {} })

test('router: each kind\'s thread opens with its title from the key, and the open event Onsen gets carries it; the second run of a schedule keeps it', async () => {
  await L.__mainEvent({ event: 'Stop', pid })
  const cases: Array<[any, string, string]> = [
    [mesh('scheduler', '[scheduled][v1571-acc][run:7170501][P3][routine] 1.57.1 驗收 排程。讀到就結束', { item_kind: 'scheduled', refs: { schedule: '6470501', run: '7170501' }, meta: { user: 'scheduler', run_id: '7170501' } }), 'schedule', '排程 v1571-acc'],
    [mesh('board', '[board][WO-570] 新指派給你：串的標題照串鍵取', { item_kind: 'board', refs: { ticket: '570' } }), 'ticket', 'WO-570 串的標題照串鍵取'],
    [mesh('alert-dispatcher', '【警報 warning】alert 70501：netdata / lab-host / cpu = 91', { item_kind: 'alert', refs: { incident: 'lab-host#70501', alert: '70501' } }), 'incident', '事故 lab-host'],
    [mesh('eve', '【信】週報格式 v1571\n要改成表格', { item_kind: 'peer_mail', line: 'mail', refs: { conversation: '205701' } }), 'mail', '週報格式 v1571'],
    [mesh('eve', '1.57.1 的標題改好了嗎？我要驗。', { thread: 'eve#t-157101', hop: 1 }), 'peer_call', 'eve：1.57.1 的標題改好了嗎'],
  ]
  for (const [ev, kk, title] of cases) {
    await L.routeEvent(ev)
    const t = threadOf(ev.id)!
    expect(t).toMatchObject({ key_kind: kk, title, title_v: TITLE_V })
    expect(opened(t.id)).toMatchObject({ event: 'open', key_kind: kk, title })
  }
  // the next run of the schedule: the same thread, the same title (not the second run's line)
  const again = mesh('scheduler', '[scheduled][v1571-acc][run:7170502][P3][routine] 第二次', { item_kind: 'scheduled', refs: { schedule: '6470501', run: '7170502' }, meta: { user: 'scheduler', run_id: '7170502' } })
  await L.routeEvent(again)
  expect(threadOf(again.id)).toMatchObject({ key: '6470501', title: '排程 v1571-acc' })
  // Joey's DM, and a topic of it that is no worker's
  for (const [topic, name, title] of [[undefined, undefined, 'Joey 私訊'], ['7701', 'Onsen 設計', 'Joey 私訊／Onsen 設計']] as const) {
    const meta: any = { chat_id: '1828', message_id: String(9100 + n++), user: 'joey', ...(topic ? { topic, topic_name: name } : {}) }
    const j = { id: `tg-1828-${meta.message_id}`, source: 'telegram', from: 'joey', text: '在嗎？標題看一下', meta, verified: true, ...(topic ? { message_thread_id: topic } : {}),
      notif: { method: 'notifications/claude/channel', params: { content: '在嗎？標題看一下', meta } } } as any
    await L.routeEvent(j)
    const t = L.__threadByKey('tg', `tg:1828${topic ? `:${topic}` : ''}`)!
    expect(t).toMatchObject({ key_kind: 'tg', title })
    expect(opened(t.id)).toMatchObject({ title })
  }
  await until(() => !L.runningLanes().length, 15000)
}, 30000)
test('a mail this agent sends opens its conversation\'s thread with that mail\'s title (the main\'s: the first line of what it sent; a lane\'s: its title)', async () => {
  L.__mainMailThread('205801', null, '請確認 1.57.1 的標題')
  expect(L.__threadByKey('mail', '205801')).toMatchObject({ lane: 'main', title: '請確認 1.57.1 的標題', title_v: TITLE_V })
  L.__mainMailThread('205802')
  expect(L.__threadByKey('mail', '205802')?.title).toBeUndefined()                         // no title known: the first answer's, at its bind
  const r = mesh('chiron', '【回信】Re: 沒標題的那封\n收到', { item_kind: 'peer_mail', line: 'mail', refs: { conversation: '205802' } })
  await L.routeEvent(r)
  expect(L.__threadByKey('mail', '205802')?.title).toBe('Re: 沒標題的那封')
  await until(() => !L.runningLanes().length, 10000)
})

// ------------------------------------------------------------------ the start: the open threads of a state file from before get their titles from the key
test('start: open keyed threads without title_v are retitled once from the key; Onsen is told as an ordinary change; closed and own threads keep theirs', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'v1571-retitle-'))
  mkdirSync(d2, { recursive: true })
  writeFileSync(join(d2, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
  const old = '[scheduled][wo164-acc][run:7170431][P3][routine] WO-164 驗收 排程第一次。這是測試台的測試件：讀到就結束'
  const th = (id: string, kk: string, key: string, title: string | undefined, extra: Record<string, unknown> = {}) =>
    ({ id, lane: null, peer: null, hops: 0, tokens: 0, created: '2026-11-25T17:05:00Z', last: '2026-11-25T17:05:00Z', key_kind: kk, key, ...(title ? { title } : {}), state: 'open', ...extra })
  const threads: Record<string, any> = {
    'r#t-sched': th('r#t-sched', 'schedule', '6470431', old),
    'r#t-tick': th('r#t-tick', 'ticket', '970431', '[board][WO-970431] 球到你手上：WO-164 驗收工單'),
    'r#t-inc': th('r#t-inc', 'incident', 'lab-host#70431', '【警報 warning】alert 70431：netdata / lab-host / cpu = 91'),
    'r#t-mail': th('r#t-mail', 'mail', 'c70431', '【信】WO-164 驗收 信'),
    'r#t-call': th('r#t-call', 'peer_call', 'chiron#t-77aa', '你那邊的串現在幾條？我要對 Onsen。', { peer: 'chiron' }),
    'r#t-tg': th('r#t-tg', 'tg', 'tg:6736970916', '請只回：收到'),
    'r#t-own': th('r#t-own', 'item', 'mesh-1795626368678-663c', '[board][WO-999] 無欄位'),
    'r#t-closed': th('r#t-closed', 'schedule', '6470999', '[scheduled][gone][run:1][P3][routine] x', { state: 'closed' }),
  }
  const sent: Record<string, any> = Object.fromEntries(Object.keys(threads).map(id => [id, { owner: null, state: threads[id].state, item: null, n: 2 }]))
  writeFileSync(join(d2, 'state.json'), JSON.stringify({ threads, thread_sent: sent, thread_epoch: 'ep0', thread_sync_at: '2026-11-25T17:07:00.166Z' }))
  const logs: string[] = []
  const prev = process.env.LANES_DIR
  process.env.LANES_DIR = d2; process.env.LANES_WAKE_DECIDE = 'r'
  const R = await import('./lanes.ts?v1571-retitle') as typeof import('./lanes.ts')
  R.lanesInit({ role: 'tg', agent: 'r', workspaceDir: d2, transcriptDir: d2, httpPort: 0, log: (_l: string, m: string) => logs.push(m), authOk: () => false, registryNames: () => [],
    sendBot: async () => 1, joeyChatId: () => '6736970916', mainStatus: () => ({ state: 'idle', detail: {} }) } as any)
  const S = R.__lanesState()
  try {
    expect(S.threads['r#t-sched'].title).toBe('排程 wo164-acc')
    expect(S.threads['r#t-tick'].title).toBe('WO-970431 WO-164 驗收工單')
    expect(S.threads['r#t-inc'].title).toBe('事故 lab-host')
    expect(S.threads['r#t-mail'].title).toBe('WO-164 驗收 信')
    expect(S.threads['r#t-call'].title).toBe('chiron：你那邊的串現在幾條')
    expect(S.threads['r#t-tg'].title).toBe('Joey 私訊')
    expect(S.threads['r#t-own'].title).toBe('[board][WO-999] 無欄位')                       // a thread of its own: as before
    expect(S.threads['r#t-closed'].title).toBe('[scheduled][gone][run:1][P3][routine] x')   // closed: as before
    expect(S.thread_sent!['r#t-sched'].title).toBe(old)                                     // what Onsen holds: the old one
    const row = readFileSync(join(d2, 'lanes.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(r => r.kind === 'thread_retitled')
    expect(row).toMatchObject({ why: 'start', n: 6 })
    expect(logs.some(m => m.includes('6 open thread(s) retitled from their key (start)'))).toBe(true)
    // the sink comes up: the handshake (Onsen answers nothing changed), then the sync: one event per retitled thread, the state kept, the title on it
    const got: any[] = []
    await R.setThreadSink({ record: evs => { got.push(...evs); return true }, fetch: async () => [], pending: () => 0 }, { waitMs: 0 })
    expect(got.map(e => [e.thread, e.event, e.title]).sort()).toEqual([
      ['r#t-call', 'open', 'chiron：你那邊的串現在幾條'], ['r#t-inc', 'open', '事故 lab-host'], ['r#t-mail', 'open', 'WO-164 驗收 信'],
      ['r#t-sched', 'open', '排程 wo164-acc'], ['r#t-tg', 'open', 'Joey 私訊'], ['r#t-tick', 'open', 'WO-970431 WO-164 驗收工單']])
    expect(got.every(e => !e.key_kind && e.dedupe.startsWith('ep0:'))).toBe(true)          // a change, not a new thread; the per-agent dedupe goes on
    // a second start retitles nothing (title_v), and nothing more is told
    const R2 = await import('./lanes.ts?v1571-retitle-2') as typeof import('./lanes.ts')
    R2.lanesInit({ role: 'tg', agent: 'r', workspaceDir: d2, transcriptDir: d2, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => [],
      sendBot: async () => 1, joeyChatId: () => '6736970916', mainStatus: () => ({ state: 'idle', detail: {} }) } as any)
    expect(R2.__lanesState().threads['r#t-sched'].title).toBe('排程 wo164-acc')
    const got2: any[] = []
    await R2.setThreadSink({ record: evs => { got2.push(...evs); return true }, fetch: async () => [], pending: () => 0 }, { waitMs: 0 })
    expect(got2).toEqual([])
    R.setThreadSink(null); R2.setThreadSink(null)
  } finally {
    process.env.LANES_DIR = prev; process.env.LANES_WAKE_DECIDE = AGENT
    try { rmSync(d2, { recursive: true, force: true }) } catch {}
  }
})
test('the start handshake: a thread Onsen holds with its old title (changed since the last handshake) is told the new one; one taken in is retitled too', async () => {
  const d3 = mkdtempSync(join(tmpdir(), 'v1571-hs-'))
  writeFileSync(join(d3, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
  const old = '[scheduled][hs-acc][run:1][P3][routine] 第一次'
  writeFileSync(join(d3, 'state.json'), JSON.stringify({ threads: { 'h#t-1': { id: 'h#t-1', lane: null, peer: null, hops: 0, tokens: 0, created: '', last: '', key_kind: 'schedule', key: '61', title: old, state: 'open' } },
    thread_sent: { 'h#t-1': { owner: null, state: 'open', item: null, n: 1 } }, thread_epoch: 'ep1' }))
  const prev = process.env.LANES_DIR
  process.env.LANES_DIR = d3; process.env.LANES_WAKE_DECIDE = 'h'
  try {
    const H = await import('./lanes.ts?v1571-hs') as typeof import('./lanes.ts')
    H.lanesInit({ role: 'tg', agent: 'h', workspaceDir: d3, transcriptDir: d3, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => [], sendBot: async () => 1,
      joeyChatId: () => '1', mainStatus: () => ({ state: 'idle', detail: {} }) } as any)
    const rows = [
      { thread: 'h#t-1', key_kind: 'schedule', key: '61', title: old, owner: null, state: 'open', last_item: null },
      { thread: 'h#t-2', key_kind: 'incident', key: 'mock-api#9', title: '[P2] mock-api 慢', owner: null, state: 'open', last_item: null, created_at: '2026-11-25T10:00:00Z', updated_at: '2026-11-25T10:00:00Z' },
    ]
    const got: any[] = []
    await H.setThreadSink({ record: evs => { got.push(...evs); return true }, fetch: async () => rows, pending: () => 0 }, { waitMs: 0 })
    expect(got.map(e => [e.thread, e.event, e.title])).toEqual([['h#t-1', 'open', '排程 hs-acc'], ['h#t-2', 'open', '事故 mock-api']])
    expect(H.__lanesState().threads['h#t-2']).toMatchObject({ title: '事故 mock-api', title_v: TITLE_V })
    H.setThreadSink(null)
  } finally {
    process.env.LANES_DIR = prev; process.env.LANES_WAKE_DECIDE = AGENT
    try { rmSync(d3, { recursive: true, force: true }) } catch {}
  }
})
