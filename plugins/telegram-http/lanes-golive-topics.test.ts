// lanes-golive: worker lanes in real Telegram private-chat topics (Bot API 10.5: the bot's topic mode, createForumTopic with Joey's user id, sends with
// message_thread_id, inbound messages carrying message_thread_id / is_topic_message), and the fallback: no topic (mode off, the API refused, or
// LANES_WORKER_TOPICS=off) = the main does the work.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const L = await import('./lanes.ts?golive-topics') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-golive-topics-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
let topicsOn = true
const created: Array<{ chat: string; name: string }> = [], sent: any[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async (chat: string, text: string, o: any) => { sent.push({ chat, text, ...o }); return 900 + sent.length }, joeyChatId: () => '1828173984',
  createTopic: async (chat: string, name: string) => { if (!topicsOn) throw new Error("Call to 'createForumTopic' failed! (400: Bad Request: the chat is not a forum)"); created.push({ chat, name }); return 7000 + created.length } } as any)
L.__setClaudeBin(join(import.meta.dir, 'test-fixtures', 'no-claude.sh'))
L.__setMainConnected('mcp-main')
afterAll(() => { delete process.env.LANES_WORKER_TOPICS })
const board = (n: number) => { const text = `[board][WO-${n}] 請 adam 處理`; return { id: `mesh-tp-${n}`, source: 'mesh', from: 'board', verified: true, text, meta: {}, line: 'call',
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }

test('a board work order opens a worker lane in a topic of Joey\'s private chat (his user id); his message in that topic reaches the worker', async () => {
  const d = await L.routeEvent(board(301))
  expect(d).toMatchObject({ rule: 'mesh-board', target: 'lane' })
  expect(created).toEqual([{ chat: '1828173984', name: '工單 WO-301' }])
  const lane = L.__lanesState().lanes[d.lane!]
  expect(lane).toMatchObject({ kind: 'worker', topic: 7001 })
  expect(L.__lanesState().topics['7001']).toBe(lane.id)
  const meta = { chat_id: '1828173984', message_id: '55', user: 'joey', message_thread_id: '7001' }
  const j = await L.routeEvent({ id: 'tg-1828173984-55', source: 'telegram', from: 'joey', text: '進度？', meta, verified: true, message_thread_id: '7001',
    notif: { method: 'notifications/claude/channel', params: { content: '進度？', meta } } } as any)
  expect(j).toMatchObject({ rule: 'tg-worker-topic', lane: lane.id })
})

test('no topic (the bot\'s topic mode is off: the API refuses): the work order goes to the main, and the main\'s open_worker says so; nothing half-open', async () => {
  topicsOn = false
  const n = Object.keys(L.__lanesState().lanes).length
  const d = await L.routeEvent(board(302))
  expect(d).toMatchObject({ rule: 'mesh-board', target: 'main' }); expect(d.note).toContain('no worker topic')
  expect(Object.keys(L.__lanesState().lanes).length).toBe(n)
  expect(await L.callMainTool('open_worker', { title: '整理報表', brief: '做完回報' }, 'mcp-main')).toContain('refused: this bot cannot open a topic')
  topicsOn = true
  process.env.LANES_WORKER_TOPICS = 'off'                                                  // the switch: never a topic, even when the API would
  const c = created.length
  expect((await L.routeEvent(board(303))).target).toBe('main')
  expect(created.length).toBe(c)
  delete process.env.LANES_WORKER_TOPICS
})

test('server.ts: a topic message is taken by its thread id (is_topic_message), the bot\'s topic mode is changed only with LANES_WORKER_TOPICS=enable', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain("(ctx.message as any)?.message_thread_id != null && (ctx.message as any)?.is_topic_message !== false")
  const f = src.slice(src.indexOf('async function laneTopicsAtStart('), src.indexOf('// Board ops room'))
  expect(f).toContain("if (mode === 'enable' && me.has_topics_enabled !== true) {")
  expect(f).toContain('setMySettings({ has_topics_enabled: true })')
  expect(src).toContain('if (Lanes.LANES_ON && !INBOX_ONLY) void laneTopicsAtStart(')
})
