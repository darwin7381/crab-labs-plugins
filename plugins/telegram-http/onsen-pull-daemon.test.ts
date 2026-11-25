// WO-151 3a / 3b end to end: real daemons (server.ts) against a stand-in Onsen (onsen5.py's contract, a local HTTP server; nothing reaches core.kbro.ai),
// in temp dirs (their HOME too).
//   on   a Telegram daemon (lanes on, the fleet router) + its agent-inbox daemon with ONSEN_PULL=adam
//   off  the same pair without the switch: the reference for "routed exactly as the same item through /inject"
//   snd  a third agent-inbox daemon (zed, lanes off) with ONSEN_SEND=zed: send_to_agent's Onsen copy, the pulling rule, the pushed mail's copy
// (a) a call, a mailbox ring, a scheduled run, an alert and a board push through the pull route as the same items through /inject (routing.jsonl);
//     first start: 3 items already in the inbox are not delivered (they came through /inject while the pull was off)
// (b) both paths with one key → delivered once, either order (an explicit key and msg:<id>); an unsigned /inject never records a key
// (c) Onsen down while 5 items are queued, then up (counted by events): all 5 in order, none twice
// (e) the sender: the same key in /inject and in Onsen; a failed push is delivered when Onsen says the recipient pulls, failed when not
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { startTgDaemon, until, freePort, sleep, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED_ON = 'mesh_PULLonSECRETsecretSECRETsecret0123456', CRED_OFF = 'mesh_PULLoffSECRETsecretSECRETsecret012345'
const CRED_SND = 'mesh_PULLsndSECRETsecretSECRETsecret012345', CRED_EVE = 'mesh_PULLeveSECRETsecretSECRETsecret012345'
const CRED_RX = 'mesh_PULLrxSECRETsecretSECRETsecret0123456'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

// ------------------------------------------------------------------ the stand-in Onsen (its state lives here: the server can stop and start again)
type MItem = { recipient: string; seq: number; sender: string; relay: string | null; kind: string; payload: any; dedupe: string | null; acked: boolean }
const store = { items: [] as MItem[], last: new Map<string, number>(), polledAt: new Map<string, number>(), sends: [] as any[], polls: [] as string[] }
const CALLER: Record<string, string> = { [CRED_ON]: 'adam', [CRED_OFF]: 'adam-off', [CRED_SND]: 'zed' }
function put(recipient: string, sender: string, relay: string | null, kind: string, payload: any, dedupe?: string | null): { to: string; seq: number; duplicate: boolean } {
  const key = dedupe || (Number.isInteger(payload?.msg_id) ? `msg:${payload.msg_id}` : null)
  const had = key ? store.items.find(i => i.recipient === recipient && i.dedupe === key) : undefined
  if (had) return { to: recipient, seq: had.seq, duplicate: true }
  const seq = (store.last.get(recipient) ?? 0) + 1
  store.last.set(recipient, seq)
  store.items.push({ recipient, seq, sender, relay, kind, payload, dedupe: key, acked: false })
  return { to: recipient, seq, duplicate: false }
}
let onsenPort = 0, onsenSrv: ReturnType<typeof Bun.serve> | null = null
function startOnsen(): void {
  onsenSrv = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', idleTimeout: 30, async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const caller = CALLER[String(req.headers.get('authorization') ?? '').replace(/^Bearer /, '')]
    if (!caller) return Response.json({ detail: 'auth' }, { status: 401 })
    const body: any = req.method === 'POST' ? await req.json() : undefined
    if (path === '/send' && req.method === 'POST') {
      store.sends.push({ caller, ...body })
      if (typeof body?.payload?.text !== 'string' || !body.payload.text) return Response.json({ detail: 'payload.text is required' }, { status: 400 })
      const tos = Array.isArray(body.to) ? body.to : [body.to]
      const results = tos.map((t: string) => ({ ...put(t, caller, null, body.kind ?? 'other', body.payload, body.dedupe), pulling: Date.now() - (store.polledAt.get(t) ?? 0) < 90_000 }))
      return Response.json({ results })
    }
    if (path === '/inbox' && req.method === 'GET') {
      const after = Number(u.searchParams.get('after') ?? 0), wait = Math.min(1, Number(u.searchParams.get('wait') ?? 0)), limit = Number(u.searchParams.get('limit') ?? 100)
      store.polledAt.set(caller, Date.now()); store.polls.push(`${caller}:${after}`)
      const last = store.last.get(caller) ?? 0
      if (after > last) return Response.json({ agent: caller, items: [], reset: true, continue_after: last, last_seq: last })
      const end = Date.now() + wait * 1000
      let rows: MItem[] = []
      while (true) {
        rows = store.items.filter(i => i.recipient === caller && i.seq > after).slice(0, limit)
        if (rows.length || Date.now() >= end) break
        await sleep(25)
      }
      // the item carries its dedupe key (the server change this daemon reads: onsen5.py _item + "dedupe")
      return Response.json({ agent: caller, last_seq: store.last.get(caller) ?? 0, items: rows.map(i => ({ seq: i.seq, sender: i.sender, relay: i.relay, kind: i.kind, payload: i.payload, dedupe: i.dedupe, at: new Date().toISOString(), given: 1 })) })
    }
    if (path === '/inbox/ack' && req.method === 'POST') {
      let n = 0
      for (const i of store.items) if (i.recipient === caller && i.seq <= body.upto && !i.acked) { i.acked = true; n++ }
      return Response.json({ acked: n })
    }
    if (path === '/inbox/status') return Response.json({ agents: [] })
    return Response.json({ detail: 'no route' }, { status: 404 })
  } })
}
/** BTCC (a relay identity) or a peer writes into adam's inbox, as POST /send would */
const enqueue = (sender: string, relay: string | null, kind: string, payload: any, dedupe?: string) => put('adam', sender, relay, kind, payload, dedupe)

// ------------------------------------------------------------------ the daemons
let root = '', apiOn: BotApiMock, apiOff: BotApiMock, on: TgDaemon, off: TgDaemon
type Inbox = { port: number; stateDir: string; proc: { kill(): void; exited: Promise<number> }; log: () => string; health: () => Promise<any> }
let inOn: Inbox, inOff: Inbox, snd: Inbox, sndClient: Client
let eveStub: ReturnType<typeof Bun.serve>, btccStub: ReturnType<typeof Bun.serve>
const eveGot: any[] = []
let eveMode: 'ok' | 'fail' = 'ok', commsMode: 'ok' | 'down' = 'ok', commsId = 8100
let mailAnswer: any = null
const mailRecord: Record<string, any> = {}

async function bootInbox(name: string, env: Record<string, string>, cred: string | null): Promise<Inbox> {
  const home = join(root, name, 'ihome'), ws = join(root, name, 'iws'), stateDir = join(ws, '.agent-inbox-state')
  for (const d of [home, ws, stateDir]) mkdirSync(d, { recursive: true })
  if (cred) writeFileSync(join(stateDir, 'mesh-credential'), cred + '\n')
  const port = await freePort()
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    cwd: import.meta.dir,
    env: {
      PATH: process.env.PATH ?? '', HOME: home, CHANNEL_INBOX_ONLY: '1', TELEGRAM_HTTP_PORT: String(port), TELEGRAM_STATE_DIR: stateDir, AGENT_WORKSPACE_DIR: ws,
      MCP_READY_DELAY_MS: '200', CRAB_LABS_PLUGINS_ENV: join(root, 'no-machine-config'), HUB_SYNC: '0', USAGE_WALL_READ: '0', TYPESAFE_KEY_FILE: '/nonexistent/typesafe.env',
      MESH_CREDENTIALS_TABLE: join(root, 'mesh-credentials.json'), ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, ONSEN_PULL_WAIT_S: '1', ONSEN_PULL_BACKOFF_MS: '150',
      ONSEN_HOST: 'lab-host', ...env,
    },
    stdout: 'ignore', stderr: 'ignore',
  })
  const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()).catch(() => null) as Promise<any>
  if (!await until(async () => (await health())?.ok === true, 20000)) throw new Error(`inbox daemon ${name} did not start`)
  return { port, stateDir, proc, health, log: () => { try { return readFileSync(join(stateDir, 'server.log'), 'utf8') } catch { return '' } } }
}
const inject = (d: Inbox, body: Record<string, unknown>, cred?: string) => fetch(`http://127.0.0.1:${d.port}/inject`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}) }, body: JSON.stringify(body) }).then(r => r.json()) as Promise<any>
const routing = (d: TgDaemon): any[] => { try { return readFileSync(join(d.ws, '.lanes', 'routing.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const rowsOf = (d: TgDaemon, text: string) => routing(d).filter(r => r.text === text)
const key = (r: any) => `${r.rule}|${r.target}|${r.lane ? String(r.lane).replace(/\.\d+$/, '') : ''}`
const pulled = async () => (await inOn.health())?.onsen_pull

beforeAll(async () => {
  onsenPort = await freePort()
  startOnsen()
  root = mkdtempSync(join(tmpdir(), 'onsen-pull-daemon-'))
  writeFileSync(join(root, 'mesh-credentials.json'), JSON.stringify({
    identities: { eve: { kind: 'agent', signing: true }, 'oncall-receiver': { kind: 'system', signing: true }, zed: { kind: 'agent', signing: true } },
    hashes: { [sha(CRED_EVE)]: 'eve', [sha(CRED_RX)]: 'oncall-receiver', [sha(CRED_SND)]: 'zed' } }))
  eveStub = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    eveGot.push(await req.json().catch(() => ({})))
    return eveMode === 'ok' ? Response.json({ injected: true, active_sessions: 1 }) : Response.json({ error: 'down' }, { status: 503 })
  } })
  btccStub = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === '/api/comms/log') return commsMode === 'ok' ? Response.json({ id: ++commsId }) : Response.json({ detail: 'down' }, { status: 500 })
    if (u.pathname === '/api/mesh/mail/send') return Response.json(mailAnswer)
    const m = u.pathname.match(/^\/api\/mesh\/mail\/(\d+)$/)
    if (m && req.method === 'GET') return mailRecord[m[1]!] ? Response.json(mailRecord[m[1]!]) : Response.json({ detail: 'no mail' }, { status: 404 })
    return Response.json({})
  } })
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ eve: { url: 'http://127.0.0.1:9/inject' }, adam: { url: 'http://127.0.0.1:9/inject' } }))
  writeFileSync(join(root, 'registry-snd.json'), JSON.stringify({ eve: { url: `http://127.0.0.1:${eveStub.port}/inject` }, adam: { url: `http://127.0.0.1:${await freePort()}/inject` } }))
  // first start: 3 items already wait in adam's inbox (sent while the pull was off; they came through /inject)
  for (let i = 1; i <= 3; i++) enqueue('iris-slack', null, 'other', { text: `WO151 old-${i}`, no_reply: true })
  apiOn = startBotApiMock({}, { pollHoldMs: 300 }); apiOff = startBotApiMock({}, { pollHoldMs: 300 })
  const tgEnv = { AGENT_INBOX_REGISTRY: join(root, 'registry.json'), ONSEN_RECORD: '0' }
  on = await startTgDaemon(apiOn, join(root, 'on'), JOEY, tgEnv)
  off = await startTgDaemon(apiOff, join(root, 'off'), JOEY, tgEnv)
  const lanes = (d: TgDaemon, who: string) => ({ AGENT_INBOX_SELF: 'adam', GENESIS_LANES: '1', LANES_AGENT: 'adam', LANES_TG_PORT: String(d.port), LANES_DIR: join(root, who, 'ilanes'),
    MCP_TOKEN_DIR: join(root, who, 'tok'), AGENT_INBOX_REGISTRY: join(root, 'registry.json') })
  inOn = await bootInbox('on', { ...lanes(on, 'on'), ONSEN_PULL: 'someone, adam' }, CRED_ON)
  inOff = await bootInbox('off', lanes(off, 'off'), CRED_OFF)
  snd = await bootInbox('snd', { AGENT_INBOX_SELF: 'zed', MCP_TOKEN_DIR: join(root, 'snd', 'tok'), AGENT_INBOX_REGISTRY: join(root, 'registry-snd.json'),
    BTCC_API_BASE: `http://127.0.0.1:${btccStub.port}`, ONSEN_SEND: 'zed' }, CRED_SND)
  sndClient = new Client({ name: 'onsen-pull-snd', version: '0' }, { capabilities: {} })
  await sndClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${snd.port}/mcp`)))
  await sleep(400)
}, 120000)
afterAll(async () => {
  try { await sndClient?.close() } catch {}
  for (const d of [inOn, inOff, snd]) { try { d?.proc.kill() } catch {} }
  await on?.stop(); await off?.stop(); apiOn?.stop(); apiOff?.stop()
  onsenSrv?.stop(true); eveStub?.stop(true); btccStub?.stop(true)
})

test('(a) first start: begins at the inbox count (the 3 old items are not delivered); then a call, a ring, a scheduled run, an alert and a board push through the pull route as through /inject', async () => {
  expect(await until(async () => (await pulled())?.baseline === 3, 15000)).toBe(true)
  expect(inOn.log()).toContain('starting at seq 3, earlier items skipped')
  const h = await pulled()
  expect(h).toMatchObject({ on: true, base: `http://127.0.0.1:${onsenPort}/api/onsen`, last_seq: 3 })
  expect((await inOff.health()).onsen_pull).toMatchObject({ on: false })
  const items = [
    { text: 'WO151 呼叫：維護幾點？', sender: 'eve', relay: null, kind: 'call', p: { msg_id: 501, logged: true, line: 'call' }, cred: CRED_EVE, b: { from: 'eve' } },
    { text: '讀信箱（2 封未讀）WO151', sender: 'mailbox', relay: 'btcc', kind: 'ring', p: { wake: 'mail', ring: true, no_reply: true, line: 'mail', logged: true }, cred: CRED_RX, b: { from: 'mailbox', verified_from: 'mailbox' } },
    { text: '[scheduled][backup-check][run:61][P3][routine] 查備份 WO151', sender: 'scheduler', relay: 'btcc', kind: 'scheduled', p: { logged: true }, cred: CRED_RX, b: { from: 'scheduler', verified_from: 'scheduler' } },
    { text: '[P1] mock-api 全掛 WO151', sender: 'alert-dispatcher', relay: 'btcc', kind: 'alert', p: { logged: true }, cred: CRED_RX, b: { from: 'alert-dispatcher', verified_from: 'alert-dispatcher' } },
    { text: '[board][WO-150] 球到你手上：照第二案做 WO151', sender: 'board', relay: 'btcc', kind: 'board', p: { msg_id: 900, logged: true }, cred: CRED_RX, b: { from: 'board', verified_from: 'board' } },
  ]
  const want: Record<string, string> = {}
  for (const it of items) {
    const r = await inject(inOff, { text: it.text, ...it.p, ...it.b }, it.cred)
    expect(r.injected).toBe(true)
    enqueue(it.sender, it.relay, it.kind, { text: it.text, ...it.p })
    expect(await until(() => rowsOf(on, it.text).length > 0 && rowsOf(off, it.text).length > 0, 20000)).toBe(true)
    want[it.kind] = key(rowsOf(off, it.text)[0])
    expect(key(rowsOf(on, it.text)[0])).toBe(want[it.kind])
    if (it.p.msg_id) expect(rowsOf(on, it.text)[0].event).toBe(`mesh-${it.p.msg_id}`)      // the same event id both ways when the BTCC id is there
    if (it.p.msg_id) expect(rowsOf(off, it.text)[0].event).toBe(`mesh-${it.p.msg_id}`)
  }
  // the fleet router's own rules picked them (verified senders on both paths)
  expect(want).toMatchObject({ call: expect.stringMatching(/^mesh-peer-call\|lane\|/), ring: expect.stringMatching(/^wake-mail\|lane\|/), scheduled: expect.stringMatching(/^mesh-scheduled\|/),
    alert: expect.stringMatching(/^mesh-alert\|/), board: expect.stringMatching(/^mesh-board\|/) })
  await sleep(500)
  for (let i = 1; i <= 3; i++) expect(rowsOf(on, `WO151 old-${i}`).length).toBe(0)
  // a 4th, sent after the start: delivered once
  enqueue('iris-slack', null, 'other', { text: 'WO151 new-4', no_reply: true })
  expect(await until(() => rowsOf(on, 'WO151 new-4').length > 0, 15000)).toBe(true)
  await sleep(400)
  expect(rowsOf(on, 'WO151 new-4').length).toBe(1)
  const h2 = await pulled()
  expect(h2).toMatchObject({ on: true, last_seq: 9, acked_seq: 9, taken: 6, delivered: 6, dup_dropped: 0, errors: 0 })
  expect(typeof h2.last_poll_at).toBe('string')
  expect(inOn.log()).toMatch(/onsen inbox: item 4 \(call\) from eve msg:501: handed on/)
  expect(inOn.log()).not.toContain(CRED_ON)
}, 90000)

test('(b) both paths with one key: delivered once, either order; an explicit key and msg:<id>; an unsigned /inject records nothing', async () => {
  const base = await pulled()
  // /inject first, then the Onsen copy
  expect((await inject(inOn, { text: 'WO151 dup-1', from: 'eve', no_reply: true, logged: true, dedupe: 'call:dup-1' }, CRED_EVE)).injected).toBe(true)
  enqueue('eve', null, 'call', { text: 'WO151 dup-1', no_reply: true, logged: true }, 'call:dup-1')
  expect(await until(async () => (await pulled()).dup_dropped === base.dup_dropped + 1, 15000)).toBe(true)
  // the Onsen copy first, then /inject
  enqueue('eve', null, 'call', { text: 'WO151 dup-2', no_reply: true, logged: true }, 'call:dup-2')
  expect(await until(() => rowsOf(on, 'WO151 dup-2').length > 0, 15000)).toBe(true)
  const late = await inject(inOn, { text: 'WO151 dup-2', from: 'eve', no_reply: true, logged: true, dedupe: 'call:dup-2' }, CRED_EVE)
  expect(late).toEqual({ injected: true, duplicate: true })
  // msg:<id> (no explicit key on either side; works with the server as deployed)
  expect((await inject(inOn, { text: 'WO151 dup-3', from: 'eve', no_reply: true, logged: true, msg_id: 950 }, CRED_EVE)).injected).toBe(true)
  enqueue('eve', null, 'call', { text: 'WO151 dup-3', no_reply: true, logged: true, msg_id: 950 })
  expect(await until(async () => (await pulled()).dup_dropped === base.dup_dropped + 2, 15000)).toBe(true)
  // unsigned, no token: delivered, but its key is not recorded (it cannot suppress the genuine one)
  expect((await inject(inOn, { text: 'WO151 dup-4', from: 'stranger', no_reply: true, logged: true, dedupe: 'call:dup-4' })).injected).toBe(true)
  enqueue('eve', null, 'call', { text: 'WO151 dup-4', no_reply: true, logged: true }, 'call:dup-4')
  expect(await until(() => rowsOf(on, 'WO151 dup-4').length === 2, 15000)).toBe(true)
  await sleep(500)
  expect([1, 2, 3].map(i => rowsOf(on, `WO151 dup-${i}`).length)).toEqual([1, 1, 1])
  const h = await pulled()
  expect(h.inject_dup_dropped).toBe(base.inject_dup_dropped + 1)
  expect(h.dup_dropped).toBe(base.dup_dropped + 2)
  expect(inOn.log()).toContain('(call:dup-1) already delivered by the /inject path: dropped')
  expect(inOn.log()).toContain('(call:dup-2) already delivered by the Onsen path: dropped')
  const file = JSON.parse(readFileSync(join(inOn.stateDir, 'onsen-inbox.json'), 'utf8'))
  expect(file.keys.map((k: [string, number]) => k[0])).toEqual(expect.arrayContaining(['msg:501', 'msg:900', 'call:dup-1', 'call:dup-2', 'msg:950']))
  expect(file.keys.map((k: [string, number]) => k[0]).filter((k: string) => k === 'call:dup-4').length).toBe(1)   // recorded once: by the Onsen copy, not by the unsigned /inject
}, 90000)

test('(c) Onsen down while 5 items are queued, then up: all 5 delivered in order, none twice', async () => {
  const before = await pulled()
  onsenSrv!.stop(true)
  expect(await until(async () => (await pulled()).errors >= before.errors + 2, 15000)).toBe(true)    // the pull is failing and backing off
  const texts = [1, 2, 3, 4, 5].map(i => `WO151 down-${i}`)
  for (const t of texts) enqueue('iris-slack', null, 'other', { text: t, no_reply: true }, `ext:${t}`)
  // while down: /inject still works
  expect((await inject(inOn, { text: 'WO151 during-down', from: 'eve', no_reply: true, logged: true }, CRED_EVE)).injected).toBe(true)
  startOnsen()
  expect(await until(() => texts.every(t => rowsOf(on, t).length > 0), 20000)).toBe(true)
  await sleep(600)
  const order = routing(on).filter(r => texts.includes(r.text)).map(r => r.text)
  expect(order).toEqual(texts)
  const h = await pulled()
  expect(h.delivered).toBe(before.delivered + 5)
  expect(h.acked_seq).toBe(h.last_seq)
  expect(inOn.log()).toContain('answers again')
}, 60000)

test('(e) the sender: one key in /inject and in Onsen; a failed push counts as delivered only when Onsen says the recipient is pulling; a pushed mail\'s copy', async () => {
  const call = async (args: Record<string, unknown>) => { const r: any = await sndClient.callTool({ name: 'send_to_agent', arguments: args }); return String(r.content?.[0]?.text ?? '') }
  // BTCC id minted: msg:<id> in both
  const t1 = await call({ line: 'call', to: 'eve', because: '測試', text: 'WO151 e1' })
  expect(t1).toMatch(/^delivered to eve's inbox/)
  const inj1 = eveGot.at(-1)
  expect(inj1).toMatchObject({ text: '因為：測試\nWO151 e1', from: 'zed', logged: true, msg_id: commsId, dedupe: `msg:${commsId}` })
  expect(await until(() => store.sends.some(s => s.payload?.text === '因為：測試\nWO151 e1'), 5000)).toBe(true)
  expect(store.sends.find(s => s.payload?.text === '因為：測試\nWO151 e1')).toEqual({ caller: 'zed', to: 'eve', kind: 'call', dedupe: `msg:${commsId}`,
    payload: { text: '因為：測試\nWO151 e1', logged: true, msg_id: commsId } })
  // BTCC unreachable: a fresh call:<uuid>, the same in both
  commsMode = 'down'
  expect(await call({ line: 'call', to: 'eve', because: '測試', text: 'WO151 e2' })).toMatch(/^delivered to eve's inbox/)
  const inj2 = eveGot.at(-1)
  expect(inj2.dedupe).toMatch(/^call:[0-9a-f-]{36}$/)
  expect(await until(() => store.sends.some(s => s.payload?.text === '因為：測試\nWO151 e2'), 5000)).toBe(true)
  expect(store.sends.find(s => s.payload?.text === '因為：測試\nWO151 e2').dedupe).toBe(inj2.dedupe)
  commsMode = 'ok'
  // the push to adam fails (nothing listens at its roster address); adam's daemon pulls: delivered, through Onsen
  const t3 = await call({ line: 'call', to: 'adam', because: '測試', text: 'WO151 e3' })
  expect(t3).toMatch(/^delivered to adam's inbox/)
  expect(await until(() => rowsOf(on, '因為：測試\nWO151 e3').length > 0, 15000)).toBe(true)
  expect(snd.log()).toMatch(/send to adam: the push failed .*; delivered through Onsen \(msg:\d+; the recipient's daemon is pulling\)/)
  // the push to eve fails and nobody pulls as eve: the failure stands (the call waits in Onsen)
  eveMode = 'fail'
  const t4 = await call({ line: 'call', to: 'eve', because: '測試', text: 'WO151 e4' })
  expect(t4).toMatch(/^send to eve FAILED \(inbox 503\) — message NOT delivered/)
  expect(store.items.some(i => i.recipient === 'eve' && i.payload.text === '因為：測試\nWO151 e4')).toBe(true)
  expect(snd.log()).toContain("in Onsen (msg:")
  eveMode = 'ok'
  // a mail pushed because eve's mailbox is off: its copy in Onsen, the text BTCC pushed, key msg:<id>; a stored mail: no copy
  mailAnswer = { id: 7001, stored: false, delivered: true }
  mailRecord['7001'] = { id: 7001, from: 'zed', to: 'eve', title: '備份', ask: '今天內確認', body: 'WO151 e5 內文', deadline: '2026-11-26T03:04:00.123456+00:00', no_reply: false, reply_to_id: null }
  const t5 = await call({ line: 'mail', to: 'eve', title: '備份', ask: '今天內確認', text: 'WO151 e5 內文' })
  expect(t5).toBe('eve 的信箱還沒開，這封照舊直接送進它的 session（#7001）。')
  expect(await until(() => store.sends.some(s => s.kind === 'mail'), 5000)).toBe(true)
  expect(store.sends.find(s => s.kind === 'mail')).toEqual({ caller: 'zed', to: 'eve', kind: 'mail', dedupe: 'msg:7001',
    payload: { text: '【信】備份\n要你：今天內確認\nWO151 e5 內文\n（期限 11-26 03:04Z。#7001）', msg_id: 7001, logged: true, line: 'mail' } })
  mailAnswer = { id: 7002, stored: true }
  expect(await call({ line: 'mail', to: 'eve', title: '存著', ask: '看一下', text: 'WO151 e6' })).toMatch(/^已放進 eve 的信箱（#7002）/)
  await sleep(500)
  expect(store.sends.filter(s => s.kind === 'mail').length).toBe(1)
  const h = (await snd.health())
  expect(h.onsen_send).toMatchObject({ on: true, sent: 5, failed: 0, delivered_by_onsen: 1 })   // e1–e4 calls and the pushed mail
  expect(h.onsen_pull).toMatchObject({ on: false })
}, 60000)
