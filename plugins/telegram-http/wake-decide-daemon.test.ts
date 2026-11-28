// Exercise the local routing journal and thread history with loopback Item and content services.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { peerRow, personRow, queuedTags, startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED_ON = 'mesh_WDonSECRETsecretSECRETsecret0123456789', CRED_OFF = 'mesh_WDoffSECRETsecretSECRETsecret012345678'
type Who = 'on' | 'off'
let apiOn: BotApiMock, apiOff: BotApiMock, on: TgDaemon, off: TgDaemon, onsenPort: number, root = ''
let up: ReturnType<typeof Bun.serve> | null = null, inboxSrv: ReturnType<typeof Bun.serve> | null = null
const wakeRows: Array<{ who: Who; item: any }> = []
const threadEvs: Array<{ who: Who; item: any }> = [], threadGets: Array<{ who: Who; q: string }> = []          // WO-164: /threads/events, GET /threads
let next = 1

function startOnsen(): void {
  up = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', idleTimeout: 60, async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const auth = req.headers.get('authorization')
    const who: Who | null = auth === `Bearer ${CRED_ON}` ? 'on' : auth === `Bearer ${CRED_OFF}` ? 'off' : null
    if (!who) return Response.json({ error: 'auth' }, { status: 401 })
    const body = req.method === 'POST' ? await req.json() : undefined
    if (path === '/wake/batch') return Response.json({ results: body.items.map((it: any) => { wakeRows.push({ who, item: it }); return { id: next++, duplicate: false } }) })
    if (path === '/threads/events') return Response.json({ results: body.items.map((it: any) => { threadEvs.push({ who, item: it }); return { id: next++, thread: it.thread, state: 'open', owner: it.owner ?? null, duplicate: false, conflict: false } }) })
    if (path === '/threads' && req.method === 'GET') { threadGets.push({ who, q: u.search }); return Response.json({ agent: 'adam', threads: [] }) }
    if (path === '/messages/batch' || path === '/deliveries/batch' || path === '/status/batch') return Response.json({ results: body.items.map(() => ({ id: next++, duplicate: false })) })
    if (path === '/events') return Response.json({ id: next++, duplicate: false })
    return Response.json({ error: 'no route' }, { status: 404 })
  } })
}
const routing = (d: TgDaemon): any[] => { try { return readFileSync(join(d.ws, '.lanes', 'routing.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
function addWork(d: TgDaemon) {
  peerRow(d, 501, 'eve', '維護幾點？')
  peerRow(d, 502, 'mailbox', '讀信箱（2 封未讀，最舊的等了 3 分鐘）', { kind: 'mail', payload: { no_reply: true, ring: true, wake: 'mail', line: 'mail' } })
  peerRow(d, 503, 'scheduler', '[scheduled][backup-check][run:61][P3][routine] 查備份', { kind: 'schedule', refs: [{ kind: 'run', value: '61' }] })
  peerRow(d, 504, 'alert-dispatcher', '[P1] mock-api 全掛', { kind: 'alert' })
  peerRow(d, 505, 'board', '[board][WO-150] 球到你手上：照第二案做', { payload: { item_kind: 'board' } })
  peerRow(d, 506, 'fleet-watchdog', '[保溫] 你閒了 50 分鐘，這一則只是為了不讓對話過期', { kind: 'keepwarm', payload: { wake: 'keepwarm', no_reply: true } })
  peerRow(d, 507, 'iris-slack', 'Slack DM from 王小明：明天的會改到 3 點', { unverified: true, payload: { no_reply: true } })
  peerRow(d, 508, 'guest', '幫我查一下 api-gw', { unverified: true })
  peerRow(d, 509, 'board', '球到你手上（沒有字頭）', { payload: { item_kind: 'board' } })
}

beforeAll(async () => {
  apiOn = startBotApiMock({}, { pollHoldMs: 300 }); apiOff = startBotApiMock({}, { pollHoldMs: 300 })
  onsenPort = await freePort()
  startOnsen()
  root = mkdtempSync(join(tmpdir(), 'wake-decide-daemon-'))
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ eve: { url: 'http://127.0.0.1:9' }, adam: { url: 'http://127.0.0.1:9' } }))
  const inboxPort = await freePort()
  let mailId = 16000
  inboxSrv = Bun.serve({ port: inboxPort, hostname: '127.0.0.1', async fetch(req) {
    const u = new URL(req.url), body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    if (u.pathname === '/lanes/mail-tool' && body?.name === 'decide_later') { const id = ++mailId; return Response.json({ text: `放進主線的信箱了（#${id}）。`, isError: false, mail_id: id, deadline: new Date(Date.now() + 3600_000).toISOString() }) }
    if (u.pathname === '/lanes/send') return Response.json({ text: 'sent', msgId: ++mailId, delivered: true })
    return Response.json({ text: 'ok', isError: false })
  } })
  const laneBin = join(root, 'lane-tool.sh')
  writeFileSync(laneBin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'test-fixtures', 'lane-tool.ts')}" "$@"\n`)
  chmodSync(laneBin, 0o755)
  const base = { ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: '/nonexistent/claude', ONSEN_REGISTRY_CLI: '0',
    ONSEN_FORM_LINKS: 'adam', AGENT_INBOX_REGISTRY: join(root, 'registry.json'), LANES_CLAUDE_BIN: laneBin, LANES_INBOX_PORT: String(inboxPort), ONSEN_WAKE_LOG: 'adam' }
  on = await startTgDaemon(apiOn, join(root, 'on'), JOEY, { ...base, FIXTURE_MEMBER_TOKEN: CRED_ON, LANES_WAKE_DECIDE: 'someone-else,adam' })
  off = await startTgDaemon(apiOff, join(root, 'off'), JOEY, { ...base, FIXTURE_MEMBER_TOKEN: CRED_OFF, LANES_WAKE_DECIDE: 'someone-else' })
}, 90000)
afterAll(async () => { await on?.stop(); await off?.stop(); apiOn?.stop(); apiOff?.stop(); up?.stop(true); inboxSrv?.stop(true) })

test('person, form and peer decisions stay in the router journal and emit no wake batch', async () => {
  for (const [daemon, api] of [[on, apiOn], [off, apiOff]] as const) {
    api.push(dm(JOEY, 7101, 'Joey：WO-157 測一下'))
    personRow(daemon, { message_id: '9201', form_id: 701, chat: String(JOEY), title: '排程', body: '週四 10:00', from: 'joey' })
    addWork(daemon)
    expect(await until(() => queuedTags(daemon).some(t => t.meta.message_id === 'form-9201'))).toBe(true)
    const expected = [501, 502, 503, 504, 505, 506, 507, 508, 509].map(n => 'item-' + n + '-v1')
    expect(await until(() => {
      const routed = new Set(routing(daemon).map(r => r.event))
      return expected.every(id => routed.has(id))
    })).toBe(true)
  }
  expect(wakeRows).toEqual([])
}, 30000)

test('WO-164 through the daemon: with the switch the threads go to Onsen (/threads/events through the spool, each first event with its key; the start handshake asked GET /threads); without it nothing', async () => {
  for (const d of [on, off]) {
    peerRow(d, 910, 'board', '[board][WO-164] 球到你手上', { payload: { item_kind: 'board' }, refs: [{ kind: 'ticket', value: '164' }] })
    peerRow(d, 911, 'board', '[board][WO-164] 對方留言了', { payload: { item_kind: 'board' }, refs: [{ kind: 'ticket', value: '164' }] })
  }
  const mine = () => threadEvs.filter(e => e.who === 'on').map(e => e.item)
  expect(await until(() => mine().some(e => e.key_kind === 'ticket' && e.key === '164') && mine().some(e => e.item?.id === 'item-911-v1'), 30000)).toBe(true)
  const t = mine().find(e => e.key_kind === 'ticket' && e.key === '164')!
  expect(t).toMatchObject({ event: 'open', owner: 'main', item: { id: 'item-910-v1', kind: 'board' } })
  expect(mine().filter(e => e.thread === t.thread && (e.event === 'open' || e.key_kind)).length).toBe(1)        // one thread for the ticket
  const ids = mine().map(e => e.dedupe)
  expect(new Set(ids).size).toBe(ids.length)
  expect(threadGets.filter(g => g.who === 'on').length).toBeGreaterThanOrEqual(1)
  expect(threadGets[0].q).toContain('agent=adam')
  expect(threadGets[0].q).toContain('state=all')
  expect(threadEvs.filter(e => e.who === 'off').length).toBe(0)
  expect(threadGets.filter(g => g.who === 'off').length).toBe(0)
  const r = routing(on).find(x => x.event === 'item-911-v1')
  expect(r?.thread).toBe(t.thread)
  expect(on.log()).toContain('threads of adam go to Onsen')
}, 60000)
