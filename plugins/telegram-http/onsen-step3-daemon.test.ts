// Onsen step 3 (WO-143) end to end: real Telegram daemons (server.ts) against the Bot API stand-in and a stand-in Onsen (a local HTTP server; nothing
// reaches core.kbro.ai), in temp dirs (their HOME too). Facts only: what Joey sees on Telegram is not looked at here because nothing of it changes.
//   lanes off: delivered when the daemon takes the message in (after its own record), seen when it is written into the session's stream, the main's
//              turns read from its transcript (busy with the tool, turn_end at turn_duration), status gone → idle → busy → idle; /healthz counts
//   lanes on:  delivered; no main registered: gone (the journal tap is attached and quiet)
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = 'mesh_STEP3DAEMONsecretSECRETsecret0123456'
let api: BotApiMock, off: TgDaemon, on: TgDaemon, onsenPort: number
let up: ReturnType<typeof Bun.serve> | null = null
const got: Array<{ path: string; item: any; at: number; seq: number }> = []
let seq = 0, next = 1

function startOnsen(): void {
  up = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const body = req.method === 'POST' ? await req.json() : undefined
    if (req.headers.get('authorization') !== `Bearer ${CRED}`) return Response.json({ error: 'auth' }, { status: 401 })
    if (path === '/messages/batch' || path === '/deliveries/batch' || path === '/status/batch') {
      for (const it of body.items) got.push({ path, item: it, at: Date.now(), seq: ++seq })
      return Response.json({ results: body.items.map(() => ({ id: next++, duplicate: false })) })
    }
    if (path === '/events') return Response.json({ id: next++, duplicate: false })
    return Response.json({ error: 'no route' }, { status: 404 })
  } })
}
const facts = (agentChat: string, id: number) => got.filter(g => g.path === '/deliveries/batch' && g.item.client_msg_id === String(id) && g.item.chat === agentChat)
const states = (id: number) => facts(String(JOEY), id).map(g => `${g.item.state}${g.item.by ? `:${g.item.by}` : ''}`)
const statuses = (agent: string) => got.filter(g => g.path === '/status/batch' && g.item.agent === agent).map(g => g.item)
const msgSeq = (id: number) => got.find(g => g.path === '/messages/batch' && g.item.direction === 'in' && g.item.client_msg_id === String(id))?.seq ?? Infinity

beforeAll(async () => {
  api = startBotApiMock({}, { pollHoldMs: 300 })
  onsenPort = await freePort()
  startOnsen()
  const root = mkdtempSync(join(tmpdir(), 'onsen3-daemon-'))
  mkdirSync(join(root, 'cred'), { recursive: true })
  writeFileSync(join(root, 'cred', 'mesh-credential'), CRED + '\n')
  const env = { ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'mesh-credential') }
  off = await startTgDaemon(api, join(root, 'off'), JOEY, { ...env, GENESIS_LANES: '0' })
}, 40000)
afterAll(async () => { await off?.stop(); await on?.stop(); api?.stop(); up?.stop(true) })

test('lanes off: delivered (after the message), seen when written into the stream, busy / turn_end from the transcript, the status, /healthz', async () => {
  expect(await until(() => statuses('adam').length > 0, 10000)).toBe(true)
  expect(statuses('adam')[0]).toMatchObject({ state: 'gone', idem_key: expect.stringMatching(/^tg:adam:st:\d+:gone$/) })
  // no session: the message is parked (delivered, not seen)
  api.push(dm(JOEY, 5001, '還沒有人在'))
  expect(await until(() => states(5001).includes('delivered'), 10000)).toBe(true)
  expect(facts(String(JOEY), 5001)[0]!.seq).toBeGreaterThan(msgSeq(5001))      // the message's own record first
  await Bun.sleep(300)
  expect(states(5001)).toEqual(['delivered'])
  // a session opens: the parked message is written into its stream: seen by the main; status idle
  const received: string[] = []
  const c = new Client({ name: 'onsen3-test', version: '0' }, { capabilities: {} })
  c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') received.push(String((n.params as any)?.meta?.message_id ?? '')) }
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${off.port}/mcp`)))
  expect(await until(() => received.includes('5001'), 15000)).toBe(true)
  expect(await until(() => states(5001).includes('seen:main'), 10000)).toBe(true)
  expect(await until(() => statuses('adam').at(-1)?.state === 'idle', 10000)).toBe(true)
  // the main's transcript (the dir the daemon reads for receipts): the message taken in, a tool, then the turn's end
  const tdir = join(off.home, '.claude', 'projects', off.ws.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(tdir, { recursive: true })
  const tf = join(tdir, `${randomUUID()}.jsonl`)
  const now = () => new Date().toISOString()
  writeFileSync(tf, JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: `<channel source="plugin:telegram-http:telegram-http" chat_id="${JOEY}" message_id="5001" user="joey" user_id="${JOEY}" ts="x">\n還沒有人在\n</channel>` }, timestamp: now() }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] }, timestamp: now() }) + '\n')
  expect(await until(() => statuses('adam').at(-1)?.state === 'busy', 20000)).toBe(true)
  expect(statuses('adam').at(-1)!.detail).toMatchObject({ tool: { name: 'Bash' }, subagents: 0, queued_joey: 0 })
  expect(typeof statuses('adam').at(-1)!.detail.turn_started_at).toBe('string')
  appendFileSync(tf, JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1200, timestamp: now() }) + '\n')
  expect(await until(() => states(5001).includes('turn_end:main'), 15000)).toBe(true)
  expect(states(5001)).toEqual(['delivered', 'seen:main', 'turn_end:main'])
  expect(await until(() => statuses('adam').at(-1)?.state === 'idle', 10000)).toBe(true)
  // a stranger's message (not on the allowlist) gets no facts
  api.push(dm(4242, 5002, 'stranger'))
  await Bun.sleep(1500)
  expect(facts('4242', 5002)).toEqual([])
  const h = await fetch(`http://127.0.0.1:${off.port}/healthz`).then(r => r.json()) as any
  expect(h.onsen).toMatchObject({ record: true, deliveries_recorded: 3, pending_bytes: 0 })
  expect(h.onsen.status_recorded).toBeGreaterThanOrEqual(4)
  expect(h.onsen.status).toMatchObject({ state: 'idle', mode: 'transcript' })
  expect(off.log()).not.toContain(CRED)
  await c.close()
}, 90000)

test('lanes on: delivered after the message; no main registered: gone; the tap is attached (the journal writes go on)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onsen3-daemon-on-'))
  mkdirSync(join(root, 'cred'), { recursive: true })
  writeFileSync(join(root, 'cred', 'mesh-credential'), CRED + '\n')
  const api2 = startBotApiMock({}, { pollHoldMs: 300 })
  try {
    on = await startTgDaemon(api2, root, JOEY, { ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_CREDENTIAL_FILE: join(root, 'cred', 'mesh-credential'),
      LANES_AGENT: 'eve', AGENT_INBOX_SELF: 'eve' })
    expect(await until(() => statuses('eve').length > 0, 10000)).toBe(true)
    expect(statuses('eve')[0]).toMatchObject({ state: 'gone' })
    api2.push(dm(JOEY, 6001, '主線不在'))
    expect(await until(() => got.some(g => g.path === '/deliveries/batch' && g.item.agent === 'eve' && g.item.client_msg_id === '6001'), 10000)).toBe(true)
    const d = got.filter(g => g.path === '/deliveries/batch' && g.item.agent === 'eve' && g.item.client_msg_id === '6001')
    expect(d.map(g => g.item.state)).toEqual(['delivered'])
    expect(d[0]!.seq).toBeGreaterThan(got.find(g => g.path === '/messages/batch' && g.item.agent === 'eve' && g.item.client_msg_id === '6001')!.seq)
    const h = await fetch(`http://127.0.0.1:${on.port}/healthz`).then(r => r.json()) as any
    expect(h.onsen.status).toMatchObject({ state: 'gone', mode: 'lanes' })
  } finally { await on?.stop(); api2.stop() }
}, 60000)
