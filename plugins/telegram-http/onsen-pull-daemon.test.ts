// WO-151 3a / 3b and WO-158 end to end: real daemons (server.ts) against a stand-in Onsen (onsen5.py's contract, a local HTTP server; nothing reaches
// core.kbro.ai), in temp dirs (their HOME too).
//   on   a Telegram daemon (lanes on, the fleet router) + its agent-inbox daemon with ONSEN_PULL=adam
//   off  the same pair without the switch: the reference for "routed exactly as the same item through /inject"
//   snd  a third agent-inbox daemon (zed, lanes off) with ONSEN_SEND=zed and ONSEN_PULL=zed: send_to_agent into Onsen only; what it takes, as its session sees it
//   pat  a fourth (lanes off) without ONSEN_SEND: the stop switch (the push to the roster url, nothing into Onsen)
// (a) a call, a mailbox ring, a scheduled run, an alert and a board push through the pull route as the same items through /inject (routing.jsonl);
//     first start (WO-158): begins after Onsen's acked_seq, so the 3 items sent before the first poll (nobody acked them) are delivered, once
// (b) both paths with one key → delivered once, either order (an explicit key and msg:<id>); an unsigned /inject never records a key
// (c) Onsen down while 5 items are queued, then up (counted by events): all 5 in order, none twice
// (e) the sender (WO-158): Onsen only, the roster url gets nothing; delivered when the recipient pulls, queued when not (new text, the row settled
//     queued), failed when Onsen refuses or is down; a mailbox-type recipient keeps its BTCC url; a pushed mail gets no copy from the daemon; no hub
//     polling; ONSEN_SEND off = the push
// (f) an item Onsen marks unverified: verified="false" in the session (a name that signs: forged, dropped); a verified item: verified="true"
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
const CRED_PAT = 'mesh_PULLpatSECRETsecretSECRETsecret012345'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

// ------------------------------------------------------------------ the stand-in Onsen (its state lives here: the server can stop and start again)
type MItem = { recipient: string; seq: number; sender: string; relay: string | null; kind: string; payload: any; dedupe: string | null; acked: boolean; unverified: boolean }
const store = { items: [] as MItem[], last: new Map<string, number>(), polledAt: new Map<string, number>(), sends: [] as any[], polls: [] as string[], acked: new Map<string, number>() }
const CALLER: Record<string, string> = { [CRED_ON]: 'adam', [CRED_OFF]: 'adam-off', [CRED_SND]: 'zed', [CRED_PAT]: 'pat' }
function put(recipient: string, sender: string, relay: string | null, kind: string, payload: any, dedupe?: string | null, unverified = false): { to: string; seq: number; duplicate: boolean } {
  const key = dedupe || (Number.isInteger(payload?.msg_id) ? `msg:${payload.msg_id}` : null)
  const had = key ? store.items.find(i => i.recipient === recipient && i.dedupe === key) : undefined
  if (had) return { to: recipient, seq: had.seq, duplicate: true }
  const seq = (store.last.get(recipient) ?? 0) + 1
  store.last.set(recipient, seq)
  store.items.push({ recipient, seq, sender, relay, kind, payload, dedupe: key, acked: false, unverified })
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
      return Response.json({ agent: caller, last_seq: store.last.get(caller) ?? 0, acked_seq: store.acked.get(caller) ?? 0,
        items: rows.map(i => ({ seq: i.seq, sender: i.sender, relay: i.relay, kind: i.kind, payload: i.payload, dedupe: i.dedupe, unverified: i.unverified, at: new Date().toISOString(), given: 1 })) })
    }
    if (path === '/inbox/ack' && req.method === 'POST') {
      let n = 0
      for (const i of store.items) if (i.recipient === caller && i.seq <= body.upto && !i.acked) { i.acked = true; n++ }
      store.acked.set(caller, Math.max(store.acked.get(caller) ?? 0, Math.min(body.upto, store.last.get(caller) ?? 0)))
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
let inOn: Inbox, inOff: Inbox, snd: Inbox, sndClient: Client, pat: Inbox, patClient: Client
let eveStub: ReturnType<typeof Bun.serve>, btccStub: ReturnType<typeof Bun.serve>
const eveGot: any[] = [], sndSeen: Array<{ content: string; meta: Record<string, string> }> = []
let commsMode: 'ok' | 'down' = 'ok', commsId = 8100
let mailAnswer: any = null
const mailRecord: Record<string, any> = {}
const logStatus: Array<{ id: number; delivery: string }> = [], mailboxGot: any[] = [], btccPaths: string[] = []

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
    return Response.json({ injected: true, active_sessions: 1 })
  } })
  btccStub = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const u = new URL(req.url)
    btccPaths.push(u.pathname)
    if (u.pathname === '/api/comms/log') return commsMode === 'ok' ? Response.json({ id: ++commsId }) : Response.json({ detail: 'down' }, { status: 500 })
    if (u.pathname === '/api/comms/log-status') { logStatus.push(await req.json()); return Response.json({ ok: true }) }
    if (u.pathname === '/api/mesh/mailbox/codex-mbx/inject') { mailboxGot.push(await req.json()); return Response.json({ injected: true, stored: true }) }
    if (u.pathname === '/api/mesh/mail/send') return Response.json(mailAnswer)
    const m = u.pathname.match(/^\/api\/mesh\/mail\/(\d+)$/)
    if (m && req.method === 'GET') return mailRecord[m[1]!] ? Response.json(mailRecord[m[1]!]) : Response.json({ detail: 'no mail' }, { status: 404 })
    return Response.json({})
  } })
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ eve: { url: 'http://127.0.0.1:9/inject' }, adam: { url: 'http://127.0.0.1:9/inject' } }))
  // the roster as agent-registry-sync writes it: eve's url answers (it must get nothing: Onsen only), adam's has nobody behind it, codex-mbx is a
  // mailbox-type identity (BTCC's mailbox inject)
  writeFileSync(join(root, 'registry-snd.json'), JSON.stringify({ eve: { url: `http://127.0.0.1:${eveStub.port}/inject` }, adam: { url: `http://127.0.0.1:${await freePort()}/inject` },
    'codex-mbx': { url: `http://127.0.0.1:${btccStub.port}/api/mesh/mailbox/codex-mbx/inject`, delivery: 'mailbox', kind: 'agent' } }))
  // first start: 3 items already wait in adam's inbox (sent before its daemon's first poll; nobody acked them)
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
    BTCC_API_BASE: `http://127.0.0.1:${btccStub.port}`, ONSEN_SEND: 'zed', ONSEN_PULL: 'zed' }, CRED_SND)
  sndClient = new Client({ name: 'onsen-pull-snd', version: '0' }, { capabilities: {} })
  sndClient.fallbackNotificationHandler = async nn => {
    if (nn.method === 'notifications/claude/channel') { const p = nn.params as any; sndSeen.push({ content: String(p?.content), meta: p?.meta ?? {} }) }
  }
  await sndClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${snd.port}/mcp`)))
  pat = await bootInbox('pat', { AGENT_INBOX_SELF: 'pat', MCP_TOKEN_DIR: join(root, 'pat', 'tok'), AGENT_INBOX_REGISTRY: join(root, 'registry-snd.json'),
    BTCC_API_BASE: `http://127.0.0.1:${btccStub.port}` }, CRED_PAT)
  patClient = new Client({ name: 'onsen-pull-pat', version: '0' }, { capabilities: {} })
  await patClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${pat.port}/mcp`)))
  expect(await until(async () => (await snd.health())?.sessions_with_open_sse === 1, 15000)).toBe(true)
  await sleep(400)
}, 120000)
afterAll(async () => {
  try { await sndClient?.close() } catch {}
  try { await patClient?.close() } catch {}
  for (const d of [inOn, inOff, snd, pat]) { try { d?.proc.kill() } catch {} }
  await on?.stop(); await off?.stop(); apiOn?.stop(); apiOff?.stop()
  onsenSrv?.stop(true); eveStub?.stop(true); btccStub?.stop(true)
})

test('(a) first start: begins after Onsen\'s acked_seq (the 3 items sent before the first poll are delivered, once); then a call, a ring, a scheduled run, an alert and a board push through the pull route as through /inject', async () => {
  expect(await until(async () => (await pulled())?.baseline === 0, 15000)).toBe(true)
  expect(inOn.log()).toContain('starting after seq 0 (the last acked in Onsen); 3 item(s) not acked yet are handed on')
  expect(await until(() => [1, 2, 3].every(i => rowsOf(on, `WO151 old-${i}`).length === 1), 15000)).toBe(true)
  expect(await until(async () => (await pulled())?.acked_seq === 3, 15000)).toBe(true)
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
  for (let i = 1; i <= 3; i++) expect(rowsOf(on, `WO151 old-${i}`).length).toBe(1)
  // a 4th, sent after the start: delivered once
  enqueue('iris-slack', null, 'other', { text: 'WO151 new-4', no_reply: true })
  expect(await until(() => rowsOf(on, 'WO151 new-4').length > 0, 15000)).toBe(true)
  await sleep(400)
  expect(rowsOf(on, 'WO151 new-4').length).toBe(1)
  const h2 = await pulled()
  expect(h2).toMatchObject({ on: true, last_seq: 9, acked_seq: 9, taken: 9, delivered: 9, dup_dropped: 0, errors: 0 })
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

test('(e) the sender (WO-158): Onsen only; delivered / queued / failed; a mailbox-type recipient keeps its BTCC url; no copy of a pushed mail; no hub polling; ONSEN_SEND off pushes', async () => {
  const call = async (c: Client, args: Record<string, unknown>) => { const r: any = await c.callTool({ name: 'send_to_agent', arguments: args }); return { text: String(r.content?.[0]?.text ?? ''), isError: !!r.isError } }
  const sendOf = (text: string) => store.sends.find(s => s.payload?.text === text)
  const statusOf = (id: number) => logStatus.filter(r => r.id === id).map(r => r.delivery)
  // eve is not pulling (nobody polls as eve): queued, in eve's Onsen inbox; the roster url gets nothing; the row settles queued; not an error
  const q = await call(sndClient, { line: 'call', to: 'eve', because: '測試', text: 'WO158 e1' })
  const id1 = commsId
  expect(q).toEqual({ text: "queued in eve's Onsen inbox (logged to BTCC Comms): eve's daemon is not taking messages right now; it gets this when it comes back. Do not send it again.", isError: false })
  expect(sendOf('因為：測試\nWO158 e1')).toEqual({ caller: 'zed', to: 'eve', kind: 'peer_call', dedupe: `msg:${id1}`,
    payload: { text: '因為：測試\nWO158 e1', logged: true, msg_id: id1 }, refs: { btcc_msg_id: id1 } })
  expect(await until(() => statusOf(id1).length > 0, 5000)).toBe(true)
  expect(statusOf(id1)).toEqual(['queued'])
  // eve's daemon polls again: delivered (today's text), still nothing at the roster url
  store.polledAt.set('eve', Date.now())
  const d = await call(sndClient, { line: 'call', to: 'eve', because: '測試', text: 'WO158 e2' })
  const id2 = commsId
  expect(d).toEqual({ text: "delivered to eve's inbox (queued durably; logged to BTCC Comms)", isError: false })
  expect(await until(() => statusOf(id2).length > 0, 5000)).toBe(true)
  expect(statusOf(id2)).toEqual(['delivered'])
  // BTCC unreachable: a fresh call:<uuid>, no 「logged」 part
  commsMode = 'down'
  expect((await call(sndClient, { line: 'call', to: 'eve', because: '測試', text: 'WO158 e3' })).text).toBe("delivered to eve's inbox (queued durably)")
  expect(sendOf('因為：測試\nWO158 e3').dedupe).toMatch(/^call:[0-9a-f-]{36}$/)
  expect(sendOf('因為：測試\nWO158 e3').payload).toEqual({ text: '因為：測試\nWO158 e3', logged: false })
  commsMode = 'ok'
  // adam's daemon pulls: delivered into adam's session through Onsen, nothing pushed to adam's roster url (nobody listens there anyway)
  expect((await call(sndClient, { line: 'call', to: 'adam', because: '測試', text: 'WO158 e4' })).text).toMatch(/^delivered to adam's inbox/)
  expect(await until(() => rowsOf(on, '因為：測試\nWO158 e4').length > 0, 15000)).toBe(true)
  expect(snd.log()).toMatch(/send to adam: in Onsen \(msg:\d+\); the recipient's daemon is pulling: delivered/)
  // Onsen down: failed, with Onsen's reason; the row settles failed; an error
  onsenSrv!.stop(true)
  const f = await call(sndClient, { line: 'call', to: 'eve', because: '測試', text: 'WO158 e5' })
  const id5 = commsId
  startOnsen()
  expect(f.isError).toBe(true)
  expect(f.text).toMatch(/^send to eve FAILED \(Onsen: .+\) — message NOT delivered$/)
  expect(await until(() => statusOf(id5).length > 0, 5000)).toBe(true)
  expect(statusOf(id5)).toEqual(['failed'])
  expect(eveGot.length).toBe(0)                                                   // the roster url got nothing, ever
  // a mailbox-type identity: today's push to its BTCC url, nothing into Onsen
  const m = await call(sndClient, { line: 'call', to: 'codex-mbx', because: '測試', text: 'WO158 e6' })
  expect(m.text).toBe("delivered to codex-mbx's inbox (queued durably; logged to BTCC Comms)")
  expect(mailboxGot.at(-1)).toEqual({ text: '因為：測試\nWO158 e6', from: 'zed', logged: true, msg_id: commsId })
  expect(store.sends.some(s => s.to === 'codex-mbx')).toBe(false)
  // an unknown name: unchanged
  expect((await call(sndClient, { line: 'call', to: 'nobody', because: '測試', text: 'x' })).text).toMatch(/^send failed: unknown agent "nobody" — registry has: eve, adam, codex-mbx$/)
  // a mail BTCC pushed because eve's mailbox is off: BTCC writes its Onsen copy; the daemon writes none (mirrorPushedMail is gone)
  mailAnswer = { id: 7001, stored: false, delivered: true }
  mailRecord['7001'] = { id: 7001, from: 'zed', to: 'eve', title: '備份', ask: '今天內確認', body: 'WO158 e7 內文', deadline: null, no_reply: false, reply_to_id: null }
  expect((await call(sndClient, { line: 'mail', to: 'eve', title: '備份', ask: '今天內確認', text: 'WO158 e7 內文' })).text).toBe('eve 的信箱還沒開，這封照舊直接送進它的 session（#7001）。')
  await sleep(500)
  expect(store.sends.some(s => s.kind === 'peer_mail')).toBe(false)
  expect(btccPaths.some(p => p === '/api/mesh/mail/7001')).toBe(false)
  // no hub sync: nothing asks BTCC for pending rows, and /healthz has no hub
  expect(btccPaths.some(p => p.startsWith('/api/mesh/inbox/'))).toBe(false)
  const h = await snd.health()
  expect(h.hub).toBeUndefined()
  expect(h.onsen_send).toMatchObject({ on: true, sent: 4, not_pulling: 1, failed: 1 })
  expect(h.onsen_pull).toMatchObject({ on: true })
  // ONSEN_SEND off (pat): the push to the roster url, nothing into Onsen
  const p = await call(patClient, { line: 'call', to: 'eve', because: '測試', text: 'WO158 e8' })
  expect(p.text).toBe("delivered to eve's inbox (queued durably; logged to BTCC Comms)")
  expect(eveGot.at(-1)).toEqual({ text: '因為：測試\nWO158 e8', from: 'pat', logged: true, msg_id: commsId })
  expect(store.sends.some(s => s.caller === 'pat')).toBe(false)
  expect((await pat.health()).onsen_send).toEqual({ on: false })
}, 60000)

test('(f) an item Onsen marks unverified reaches the session as verified="false"; one naming an identity that signs is forged and dropped; a verified one is verified="true"', async () => {
  const seen = (t: string) => sndSeen.filter(x => x.content === t)
  put('zed', '⚠️released#7', 'btcc', 'peer_call', { text: 'WO158 f1 released', logged: true, msg_id: 9101 }, null, true)
  put('zed', 'eve', 'btcc', 'peer_call', { text: 'WO158 f2 claims eve', logged: true, msg_id: 9102 }, null, true)
  put('zed', 'eve', null, 'peer_call', { text: 'WO158 f3 eve', logged: true, msg_id: 9103 })
  expect(await until(() => seen('WO158 f1 released').length > 0 && seen('WO158 f3 eve').length > 0, 15000)).toBe(true)
  await sleep(400)
  expect(seen('WO158 f1 released')[0]!.meta).toMatchObject({ user: '⚠️released#7', verified: 'false', relay: 'btcc', btcc_msg_id: '9101' })
  expect(seen('WO158 f1 released')[0]!.meta.forged).toBeUndefined()
  expect(seen('WO158 f2 claims eve').length).toBe(0)
  expect(snd.log()).toContain('DROPPED forged inject (filed for review): claimed=eve relay=btcc text=WO158 f2 claims eve')
  expect(seen('WO158 f3 eve')[0]!.meta).toMatchObject({ user: 'eve', verified: 'true', relay: 'direct' })
  expect(snd.log()).toMatch(/onsen inbox: item \d+ \(peer_call\) from ⚠️released#7 via btcc \(unverified\) msg:9101: handed on/)
}, 30000)
