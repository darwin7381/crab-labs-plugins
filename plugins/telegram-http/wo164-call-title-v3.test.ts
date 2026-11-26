// Chiron #200144 (after 1.57.2): a call from a peer that a reflex lane took is a thread of its own (key_kind item, key mesh-<n>) and was titled by its first
// line, 「因為：WO-167 的設計貼好了…」: no peer, the 「因為：」 head kept. A call's title is 「<對方>：<那一句前 30 字>」 with the head dropped, for those threads
// too; the start retitles the open ones once (TITLE_V 3): a thread from before 1.57.2 from its old title, a 1.57.2 call title (「<對方>：因為：…」) without
// the head; every other 1.57.2 title is left as it is.
import { test, expect, afterAll } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { threadTitle, callBody, TITLE_V } from './lanes-threads.ts'

const LONG = 'WO-167 的設計貼好了，你在等這個才能動手做第二段的程式和測試'          // 34 characters: the title takes 30
const L30 = 'WO-167 的設計貼好了，你在等這個才能動手做第二段的程式'

test('a call\'s title drops the 「因為：」 head its sender\'s daemon writes; 30 characters of the sentence after it', () => {
  expect(TITLE_V).toBe(4)                                                         // 4 (1.58.13): only DM titles changed since
  const text = `因為：${LONG}。\n設計稿在 WO-167 的留言`
  expect(threadTitle('item', 'mesh-200144', { kind: 'peer_call', from: 'chiron', text })).toBe(`chiron：${L30}`)
  expect(threadTitle('peer_call', 'chiron#t-1a2b', { kind: 'peer_call', from: 'chiron', text })).toBe(`chiron：${L30}`)
  expect(threadTitle('item', 'mesh-200145', { kind: 'peer_call', from: 'eve', text: '維護幾點？' })).toBe('eve：維護幾點')   // an answer to a call: no head
  expect(callBody('因為：Joey 在等\n內文')).toBe('Joey 在等\n內文')
  expect(callBody('內文裡的因為：不動')).toBe('內文裡的因為：不動')
  // not a call: as before
  expect(threadTitle('item', 'mesh-9', { kind: 'board', text: '[board][WO-999] 無欄位' })).toBe('[board][WO-999] 無欄位')
})

// ------------------------------------------------------------------ the router: a call with no thread field opens a thread of its own, titled as a call
const AGENT = 'v1573t'
process.env.LANES_WAKE_DECIDE = AGENT
const inboxSrv = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  return new URL(req.url).pathname === '/lanes/offer' ? Response.json({ offered: true }) : Response.json({ ok: true, text: 'ok' })
} })
process.env.LANES_INBOX_PORT = String(inboxSrv.port)
const L = await import('./lanes.ts?v1573-call') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'v1573-call-'))
process.env.LANES_DIR = dir
writeFileSync(join(dir, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
writeFileSync(join(dir, 'main.json'), JSON.stringify({ session_id: 'a20fb7c0-f35a-4365-9a21-9e16e9f78fed', transcript_path: join(dir, 'main.jsonl'), claude_pid: 1, registered_at: new Date().toISOString() }))
L.lanesInit({ role: 'tg', agent: AGENT, workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, notifySession: async () => true, streamOpen: () => true,
  registryNames: () => ['chiron', 'eve'], sendBot: async () => 1, joeyChatId: () => '1828', mainStatus: () => ({ state: 'idle', detail: {} }) } as any)
L.__setMainConnected('mcp-main')
L.__setMeshSend(async b => ({ msgId: 98001, text: `sent to ${b.to}`, delivered: true }))
const bin = join(dir, 'lane-ok.sh')
writeFileSync(bin, '#!/bin/sh\necho \'{"type":"result","subtype":"success","is_error":false,"result":"ok"}\'\n')
chmodSync(bin, 0o755)
const realBin = L.__setClaudeBin(bin)
const told: any[] = []
afterAll(() => { inboxSrv.stop(true); delete process.env.LANES_INBOX_PORT; L.__setMeshSend(null); L.__setClaudeBin(realBin); L.setThreadSink(null); delete process.env.LANES_WAKE_DECIDE
  try { rmSync(dir, { recursive: true, force: true }) } catch {} })
const until = async (f: () => boolean, ms = 8000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await new Promise(r => setTimeout(r, 50)) } return f() }

test('router: chiron\'s call with a because and no thread field: a reflex lane, a thread of its own (item mesh-<n>) titled 「chiron：…」; Onsen\'s open carries it', async () => {
  await L.setThreadSink({ record: evs => { told.push(...evs); return true }, fetch: async () => [], pending: () => 0 }, { waitMs: 0 })
  await L.__mainEvent({ event: 'Stop', pid: process.pid })
  const text = `因為：${LONG}。\n設計稿在 WO-167 的留言`
  const ev = { id: 'mesh-200144', source: 'mesh', from: 'chiron', text, verified: true, meta: { user: 'chiron' }, notif: { method: 'notifications/claude/channel', params: { content: text, meta: { user: 'chiron' } } },
    line: 'call', btcc_msg_id: '200144', item_kind: 'peer_call' } as any
  const d = await L.routeEvent(ev)
  expect(d).toMatchObject({ target: 'lane' })
  const t = L.__threadByKey('item', 'mesh-200144')!
  expect(t).toMatchObject({ key_kind: 'item', key: 'mesh-200144', peer: 'chiron', title: `chiron：${L30}`, title_v: TITLE_V })
  expect(told.find(e => e.thread === t.id && e.key_kind)).toMatchObject({ event: 'open', key_kind: 'item', title: `chiron：${L30}` })
  await until(() => !L.runningLanes().length, 10000)
})

// ------------------------------------------------------------------ the start: once more for the call titles (TITLE_V 3)
test('start: a call a reflex lane took before 1.57.2 and a 1.57.2 call title get 「<對方>：…」 without the head; other 1.57.2 titles and own threads stay; Onsen told once', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'v1573-retitle-'))
  writeFileSync(join(d2, 'router.json'), readFileSync(join(import.meta.dir, 'lanes-router.fleet.json'), 'utf8'))
  const th = (id: string, kk: string, key: string, title: string | undefined, extra: Record<string, unknown> = {}) =>
    ({ id, lane: null, peer: null, hops: 0, tokens: 0, created: '2026-11-25T20:00:00Z', last: '2026-11-25T20:00:00Z', key_kind: kk, key, ...(title ? { title } : {}), state: 'open', ...extra })
  const threads: Record<string, any> = {
    // before 1.57.2 (no title_v): the call's first line
    'r#t-old': th('r#t-old', 'item', 'mesh-200101', `因為：${LONG}`, { peer: 'chiron' }),
    // 1.57.2 (title_v 2): its call titles kept the head
    'r#t-v2item': th('r#t-v2item', 'item', 'mesh-200102', 'chiron：因為：WO-168 的評審意見回來了，三點要改，第二點會影響', { peer: 'chiron', title_v: 2 }),
    'r#t-v2call': th('r#t-v2call', 'peer_call', 'sonn#t-004036', 'sonn：因為：WO-164 lab 測試在等', { title_v: 2 }),
    // 1.57.2 titles that stay as they are
    'r#t-sched': th('r#t-sched', 'schedule', '6470431', '排程 wo164-acc', { title_v: 2 }),
    'r#t-tick': th('r#t-tick', 'ticket', '570', 'WO-570 串的標題照串鍵取', { title_v: 2 }),
    'r#t-call2': th('r#t-call2', 'peer_call', 'eve#t-c0ffee', 'eve：維護幾點', { peer: 'eve', title_v: 2 }),
    'r#t-mail': th('r#t-mail', 'mail', '200093', undefined, { title_v: 2 }),
    // a thread of its own no peer's call opened (before 1.57.2): as it was
    'r#t-own': th('r#t-own', 'item', 'mesh-1795626368678-663c', '[board][WO-999] 無欄位'),
    'r#t-closed': th('r#t-closed', 'item', 'mesh-200103', '因為：關了的串', { peer: 'chiron', state: 'closed' }),
  }
  const sent = Object.fromEntries(Object.keys(threads).map(id => [id, { owner: null, state: threads[id].state, item: null, n: 4, ...(threads[id].title_v ? { title: threads[id].title ?? null } : {}) }]))
  writeFileSync(join(d2, 'state.json'), JSON.stringify({ threads, thread_sent: sent, thread_epoch: 'ep3', thread_sync_at: '2026-11-25T21:00:00Z' }))
  const prev = process.env.LANES_DIR
  process.env.LANES_DIR = d2; process.env.LANES_WAKE_DECIDE = 'r'
  try {
    const R = await import('./lanes.ts?v1573-retitle') as typeof import('./lanes.ts')
    R.lanesInit({ role: 'tg', agent: 'r', workspaceDir: d2, transcriptDir: d2, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['chiron', 'eve', 'sonn'],
      sendBot: async () => 1, joeyChatId: () => '1', mainStatus: () => ({ state: 'idle', detail: {} }) } as any)
    const S = R.__lanesState()
    expect(S.threads['r#t-old'].title).toBe(`chiron：${L30}`)
    expect(S.threads['r#t-v2item'].title).toBe('chiron：WO-168 的評審意見回來了，三點要改，第二點會影響')
    expect(S.threads['r#t-v2call'].title).toBe('sonn：WO-164 lab 測試在等')
    expect(S.threads['r#t-sched'].title).toBe('排程 wo164-acc')
    expect(S.threads['r#t-tick'].title).toBe('WO-570 串的標題照串鍵取')
    expect(S.threads['r#t-call2'].title).toBe('eve：維護幾點')
    expect(S.threads['r#t-mail'].title).toBeUndefined()
    expect(S.threads['r#t-own'].title).toBe('[board][WO-999] 無欄位')
    expect(S.threads['r#t-closed'].title).toBe('因為：關了的串')
    expect(Object.values(S.threads).filter((t: any) => t.state !== 'closed').every((t: any) => t.title_v === TITLE_V)).toBe(true)
    const got: any[] = []
    await R.setThreadSink({ record: evs => { got.push(...evs); return true }, fetch: async () => [], pending: () => 0 }, { waitMs: 0 })
    expect(got.map(e => [e.thread, e.event, e.title]).sort()).toEqual([
      ['r#t-old', 'open', `chiron：${L30}`], ['r#t-v2call', 'open', 'sonn：WO-164 lab 測試在等'], ['r#t-v2item', 'open', 'chiron：WO-168 的評審意見回來了，三點要改，第二點會影響']])
    R.setThreadSink(null)
  } finally {
    process.env.LANES_DIR = prev; process.env.LANES_WAKE_DECIDE = AGENT
    try { rmSync(d2, { recursive: true, force: true }) } catch {}
  }
})
