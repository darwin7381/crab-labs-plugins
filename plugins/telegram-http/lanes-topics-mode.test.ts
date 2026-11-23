// lanes-topics item 1: the bot's topic mode is ONE decision. Measured 11-23 in a real client: has_topics_enabled=true alone left
// allows_users_to_create_topics true, and then every message Joey typed outside a topic opened a new topic (his chat that day). So
// LANES_WORKER_TOPICS=enable sends both fields in one setMySettings call and checks both with getMe; auto changes nothing and, when getMe shows the
// broken mode, warns once and opens no worker topic (the main does the work); the check is asked again when a worker opens.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, copyFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TOPIC_SETTINGS, USERS_CREATE_WHY, topicMode, topicModeAtStart, topicVerdict } from './lanes-topics.ts'
import { startBotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until } from './test-fixtures/tg-daemon.ts'

test('topicVerdict: usable only with topics on AND only the bot opening them; the broken mode and topics off are not; a getMe that says neither is not known', () => {
  expect(topicVerdict({ has_topics_enabled: true, allows_users_to_create_topics: false }).usable).toBe(true)
  expect(topicVerdict({ has_topics_enabled: true, allows_users_to_create_topics: true })).toEqual({ usable: false, why: USERS_CREATE_WHY })
  expect(topicVerdict({ has_topics_enabled: false, allows_users_to_create_topics: false }).usable).toBe(false)
  expect(topicVerdict({}).usable).toBeNull()
  expect(topicVerdict(null).usable).toBeNull()
  expect(topicMode('enable')).toBe('enable'); expect(topicMode(' off ')).toBe('off'); expect(topicMode(undefined)).toBe('auto'); expect(topicMode('yes')).toBe('auto')
})

const fakeApi = (after: Record<string, unknown>, fail = false) => {
  const sets: unknown[] = []; let gets = 0
  return { sets, gets: () => gets, api: {
    setMySettings: async (p: unknown) => { if (fail) throw new Error('400: Bad Request'); sets.push(p) },
    getMe: async () => { gets++; return after } } }
}

test('enable: one setMySettings call with has_topics_enabled=true AND allows_users_to_create_topics=false, then both are checked with getMe', async () => {
  const f = fakeApi({ has_topics_enabled: true, allows_users_to_create_topics: false })
  const r = await topicModeAtStart('enable', { has_topics_enabled: true, allows_users_to_create_topics: true }, f.api)
  expect(f.sets).toEqual([{ has_topics_enabled: true, allows_users_to_create_topics: false }])
  expect(f.sets[0]).toEqual({ ...TOPIC_SETTINGS })
  expect(f.gets()).toBe(1)
  expect(r).toMatchObject({ set: true, warn: null, verdict: { usable: true } })
})

test('enable: a getMe after the call that still shows users opening topics (or topics off) is not trusted: warned, worker topics not used', async () => {
  const f = fakeApi({ has_topics_enabled: true, allows_users_to_create_topics: true })
  const r = await topicModeAtStart('enable', { has_topics_enabled: false }, f.api)
  expect(f.sets.length).toBe(1)
  expect(r.verdict.usable).toBe(false)
  expect(r.warn).toContain('did not take')
  expect(r.warn).toContain('allows_users_to_create_topics=true')
  const g = fakeApi({}, true)
  const r2 = await topicModeAtStart('enable', { has_topics_enabled: false }, g.api)
  expect(r2.verdict.usable).toBe(false); expect(r2.warn).toContain('setMySettings failed')
})

test('enable when getMe already shows the mode: nothing is sent', async () => {
  const f = fakeApi({})
  const r = await topicModeAtStart('enable', { has_topics_enabled: true, allows_users_to_create_topics: false }, f.api)
  expect(f.sets).toEqual([]); expect(f.gets()).toBe(0); expect(r).toMatchObject({ set: false, warn: null, verdict: { usable: true } })
})

test('auto changes nothing: the broken mode gets one warning and is not used; topics off is not used, without a warning; off asks nothing', async () => {
  const f = fakeApi({})
  const broken = await topicModeAtStart('auto', { has_topics_enabled: true, allows_users_to_create_topics: true }, f.api)
  expect(broken).toMatchObject({ set: false, warn: USERS_CREATE_WHY, verdict: { usable: false } })
  const off = await topicModeAtStart('auto', { has_topics_enabled: false, allows_users_to_create_topics: false }, f.api)
  expect(off).toMatchObject({ set: false, warn: null, verdict: { usable: false } })
  const sw = await topicModeAtStart('off', { has_topics_enabled: true, allows_users_to_create_topics: false }, f.api)
  expect(sw).toMatchObject({ set: false, warn: null, verdict: { usable: false } })
  expect(f.sets).toEqual([]); expect(f.gets()).toBe(0)
})

// ---- lanes: a worker asks the mode when it opens
const L = await import('./lanes.ts?topics-mode') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'lanes-topics-mode-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
let mode = { has_topics_enabled: true, allows_users_to_create_topics: true }
const created: string[] = []
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, authOk: () => false, registryNames: () => ['eve'],
  sendBot: async () => 1, joeyChatId: () => '1828173984', topicsUsable: async () => topicVerdict(mode),
  createTopic: async (_c: string, name: string) => { created.push(name); return 7100 + created.length } } as any)
L.__setClaudeBin(join(import.meta.dir, 'test-fixtures', 'no-claude.sh'))
L.__setMainConnected('mcp-main')
const board = (n: number) => { const text = `[board][WO-${n}] 請 adam 處理`; return { id: `mesh-tm-${n}`, source: 'mesh', from: 'board', verified: true, text, meta: {}, line: 'call',
  notif: { method: 'notifications/claude/channel', params: { content: text, meta: {} } } } as any }

test('in the broken mode no worker topic is opened: open_worker is refused with the reason, a board work order goes to the main; nothing half-open', async () => {
  const n = Object.keys(L.__lanesState().lanes).length
  const r = await L.callMainTool('open_worker', { title: '整理報表', brief: '做完回報' }, 'mcp-main')
  expect(r).toContain('refused: this bot cannot open a topic')
  expect(r).toContain('allows_users_to_create_topics=true')
  const d = await L.routeEvent(board(401))
  expect(d).toMatchObject({ rule: 'mesh-board', target: 'main' }); expect(d.note).toContain('topic mode not usable')
  expect(created).toEqual([]); expect(Object.keys(L.__lanesState().lanes).length).toBe(n)
  const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8')
  expect(ledger).toContain('沒開工作線的話題')
})

test('the mode set right (asked again at the next open): the worker opens in a topic', async () => {
  mode = { has_topics_enabled: true, allows_users_to_create_topics: false }
  const r = await L.callMainTool('open_worker', { title: '整理報表', brief: '做完回報' }, 'mcp-main')
  expect(r).toContain('opened in topic #7101')
  expect(created.length).toBe(1)
})

// ---- the daemon: the real calls at start (server.ts laneTopicsAtStart through grammy against the Bot API stand-in)
const roots: Array<{ stop: () => Promise<void> }> = []
afterAll(async () => { for (const r of roots) await r.stop() })

test('daemon, LANES_WORKER_TOPICS=enable, the bot\'s topic mode off: ONE setMySettings with both fields, then getMe; usable', async () => {
  const api = startBotApiMock({ has_topics_enabled: false, allows_users_to_create_topics: false })
  const d = await startTgDaemon(api, mkdtempSync(join(tmpdir(), 'lanes-topics-mode-d1-')), 1828, { LANES_WORKER_TOPICS: 'enable' })
  roots.push({ stop: async () => { await d.stop(); api.stop() } })
  expect(await until(() => d.log().includes('lanes: worker topics enable'))).toBe(true)
  const sets = api.of('setMySettings')
  expect(sets.length).toBe(1)
  expect(sets[0].body).toEqual({ has_topics_enabled: true, allows_users_to_create_topics: false })
  expect(api.calls.filter(c => c.method === 'getMe' && c.at >= sets[0].at).length).toBeGreaterThanOrEqual(1)
  expect(api.me).toMatchObject({ has_topics_enabled: true, allows_users_to_create_topics: false })
  expect(d.log()).toContain('lanes: worker topics enable: usable (setMySettings sent)')
}, 40000)

test('daemon, auto, getMe shows the broken mode: nothing is changed, one clear warning', async () => {
  const api = startBotApiMock({ has_topics_enabled: true, allows_users_to_create_topics: true })
  const d = await startTgDaemon(api, mkdtempSync(join(tmpdir(), 'lanes-topics-mode-d2-')), 1828, {})
  roots.push({ stop: async () => { await d.stop(); api.stop() } })
  expect(await until(() => d.log().includes('lanes: worker topics auto'))).toBe(true)
  expect(api.of('setMySettings')).toEqual([])
  const warns = d.log().split('\n').filter(l => l.includes('lanes: worker topics:'))
  expect(warns.length).toBe(1)
  expect(warns[0]).toContain('allows_users_to_create_topics=true')
  expect(d.log()).toContain('lanes: worker topics auto: not used')
}, 40000)
