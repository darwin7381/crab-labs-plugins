import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { until, freePort, sleep } from './test-fixtures/tg-daemon.ts'

const CRED_SND = 'test-sender', CRED_PAT = 'test-pat'
const CALLER: Record<string, string> = { [CRED_SND]: 'zed', [CRED_PAT]: 'pat' }
const recipientOf = new Map<string, any>()
const store = { sends: [] as any[], polledAt: new Map<string, number>() }
let onsenPort = 0, onsenSrv: ReturnType<typeof Bun.serve> | null = null
function startOnsen() {
  onsenSrv = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', async fetch(req) {
    const caller = CALLER[String(req.headers.get('authorization')).replace(/^Bearer /, '')]
    if (!caller) return Response.json({}, { status: 401 })
    if (new URL(req.url).pathname !== '/api/onsen/send') return new Response('', { status: 404 })
    const b = await req.json() as any
    store.sends.push({ caller, ...b })
    return Response.json({ results: [{ to: b.to, seq: store.sends.length, pulling: Date.now() - (store.polledAt.get(b.to) ?? 0) < 45_000,
      recipient: recipientOf.get(b.to) }] })
  } })
}
let root = ''
type Inbox = { port: number; stateDir: string; proc: { kill(): void; exited: Promise<number> }; log: () => string; health: () => Promise<any> }
let snd: Inbox, sndClient: Client, pat: Inbox, patClient: Client
let eveStub: ReturnType<typeof Bun.serve>, btccStub: ReturnType<typeof Bun.serve>
const eveGot: any[] = []
let commsMode: 'ok' | 'down' = 'ok', commsId = 8100
let mailAnswer: any = null
const mailRecord: Record<string, any> = {}
const logStatus: Array<{ id: number; delivery: string }> = [], mailboxGot: any[] = [], btccPaths: string[] = []

async function bootInbox(name: string, env: Record<string, string>, cred: string): Promise<Inbox> {
  const home = join(root, name, 'ihome'), ws = join(root, name, 'iws'), stateDir = join(ws, '.agent-inbox-state')
  for (const d of [home, ws, stateDir]) mkdirSync(d, { recursive: true })
  const port = await freePort()
  const proc = Bun.spawn([process.execPath, '--no-env-file', '--preload', join(import.meta.dir, 'test-fixtures/item-daemon.ts'), join(import.meta.dir, 'server.ts')], {
    cwd: import.meta.dir,
    env: {
      PATH: process.env.PATH ?? '', HOME: home, CHANNEL_INBOX_ONLY: '1', TELEGRAM_HTTP_PORT: String(port), TELEGRAM_STATE_DIR: stateDir, AGENT_WORKSPACE_DIR: ws,
      MCP_READY_DELAY_MS: '200', CRAB_LABS_PLUGINS_ENV: join(root, 'no-machine-config'), HUB_SYNC: '0', USAGE_WALL_READ: '0', TMPDIR: root, TYPESAFE_KEY_FILE: join(root, 'no-key'),
      FIXTURE_MEMBER_TOKEN: cred, ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`,
      ONSEN_HOST: 'lab-host', ...env,
    },
    stdout: 'ignore', stderr: 'ignore',
  })
  const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()).catch(() => null) as Promise<any>
  if (!await until(async () => (await health())?.ok === true, 20000)) throw new Error(`inbox daemon ${name} did not start`)
  return { port, stateDir, proc, health, log: () => { try { return readFileSync(join(stateDir, 'server.log'), 'utf8') } catch { return '' } } }
}
beforeAll(async () => {
  onsenPort = await freePort()
  startOnsen()
  root = mkdtempSync(join(tmpdir(), 'onsen-send-daemon-'))
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
  writeFileSync(join(root, 'registry-snd.json'), JSON.stringify({ eve: { url: `http://127.0.0.1:${eveStub.port}/inject` }, adam: { url: `http://127.0.0.1:${await freePort()}/inject` },
    'codex-mbx': { url: `http://127.0.0.1:${btccStub.port}/api/mesh/mailbox/codex-mbx/inject`, delivery: 'mailbox', kind: 'agent' } }))
  snd = await bootInbox('snd', { AGENT_INBOX_SELF: 'zed', MCP_TOKEN_DIR: join(root, 'snd', 'tok'), AGENT_INBOX_REGISTRY: join(root, 'registry-snd.json'),
    BTCC_API_BASE: `http://127.0.0.1:${btccStub.port}`, ONSEN_SEND: 'zed' }, CRED_SND)
  sndClient = new Client({ name: 'onsen-send-snd', version: '0' }, { capabilities: {} })
  await sndClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${snd.port}/mcp`)))
  pat = await bootInbox('pat', { AGENT_INBOX_SELF: 'pat', MCP_TOKEN_DIR: join(root, 'pat', 'tok'), AGENT_INBOX_REGISTRY: join(root, 'registry-snd.json'),
    BTCC_API_BASE: `http://127.0.0.1:${btccStub.port}` }, CRED_PAT)
  patClient = new Client({ name: 'onsen-send-pat', version: '0' }, { capabilities: {} })
  await patClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${pat.port}/mcp`)))
  expect(await until(async () => (await snd.health())?.sessions_with_open_sse === 1, 15000)).toBe(true)
  await sleep(400)
}, 120000)
afterAll(async () => {
  try { await sndClient?.close() } catch {}
  try { await patClient?.close() } catch {}
  for (const d of [snd, pat]) { d?.proc.kill(); await d?.proc.exited }
  onsenSrv?.stop(true); eveStub?.stop(true); btccStub?.stop(true)
})

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
  store.polledAt.set('adam', Date.now())
  // adam is receiving: delivered into adam's session through Onsen, nothing pushed to adam's roster url (nobody listens there anyway)
  expect((await call(sndClient, { line: 'call', to: 'adam', because: '測試', text: 'WO158 e4' })).text).toMatch(/^delivered to adam's inbox/)
  expect(sendOf('因為：測試\nWO158 e4').to).toBe('adam')
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
  expect(h.onsen_pull).toBeUndefined()
  // ONSEN_SEND off (pat): the push to the roster url, nothing into Onsen
  const p = await call(patClient, { line: 'call', to: 'eve', because: '測試', text: 'WO158 e8' })
  expect(p.text).toBe("delivered to eve's inbox (queued durably; logged to BTCC Comms)")
  expect(eveGot.at(-1)).toEqual({ text: '因為：測試\nWO158 e8', from: 'pat', logged: true, msg_id: commsId })
  expect(store.sends.some(s => s.caller === 'pat')).toBe(false)
  expect((await pat.health()).onsen_send).toEqual({ on: false })
}, 60000)

test('(g) WO-164 point 7 (Chiron 15:56Z, his words): the recipient\'s state Onsen answers with follows the original sentence of send_to_agent (call; mail when its answer carries it); idle adds nothing', async () => {
  const call = async (args: Record<string, unknown>) => { const r: any = await sndClient.callTool({ name: 'send_to_agent', arguments: args }); return { text: String(r.content?.[0]?.text ?? ''), isError: !!r.isError } }
  store.polledAt.set('eve', Date.now())                                          // eve's daemon pulls: delivered
  const ORIG = "delivered to eve's inbox (queued durably; logged to BTCC Comms)"
  const want: Array<[any, string]> = [
    [{ state: 'idle', reporting: 'live', reported_s_ago: 3 }, ''],
    [{ state: 'busy', reporting: 'live', reported_s_ago: 3 }, ''],
    [{ state: 'busy', reporting: 'live', reported_s_ago: 3, walled_until: '2026-11-25T07:30:00Z' }, ' eve 現在撞到用量上限，約 15:30 恢復。你的訊息排著，它恢復後才會看到。'],
    [{ state: 'offline', reporting: 'live', reported_s_ago: 3 }, ' eve 的主線現在不在線上。例行的事它的分身照常處理；要主線決定的，等它回來才會看到。'],
    [{ state: 'waiting', reporting: 'live', reported_s_ago: 3, waiting_for: 'permission prompt' }, ' eve 的主線停在一個選單上等 Joey 按，按完之前看不到你的訊息；例行的事它的分身照常處理。'],
    [{ state: 'idle', reporting: 'lost', reported_s_ago: 120 }, ' eve 已經 120 秒沒有回報狀態，可能沒在跑。訊息排著。'],
    [null, ''],
  ]
  let k = 0
  for (const [rec, tail] of want) {
    recipientOf.set('eve', rec)
    const r = await call({ line: 'call', to: 'eve', because: '測試', text: `WO164 g${++k}` })
    expect(r).toEqual({ text: ORIG + tail, isError: false })
  }
  // not pulling and offline: the 1.52.0 sentence for its own case, then the state's
  store.polledAt.set('eve', 0)
  recipientOf.set('eve', { state: 'offline', reporting: 'live', reported_s_ago: 3 })
  expect((await call({ line: 'call', to: 'eve', because: '測試', text: 'WO164 g9' })).text).toBe("queued in eve's Onsen inbox (logged to BTCC Comms): eve's daemon is not taking messages right now; it gets this when it comes back. Do not send it again. eve 的主線現在不在線上。例行的事它的分身照常處理；要主線決定的，等它回來才會看到。")
  recipientOf.delete('eve')
  // a mail whose answer carries the recipient's state (Onsen's mailbox send does not yet: then nothing is added)
  mailAnswer = { id: 7002, stored: true, recipient: { state: 'offline', reporting: 'live', reported_s_ago: 5 } }
  expect((await call({ line: 'mail', to: 'eve', title: '備份', ask: '今天內確認', text: 'WO164 g10' })).text)
    .toBe('已放進 eve 的信箱（#7002）。它一小時內會知道有信；讀了沒用 mail_sent 查。eve 的主線現在不在線上。例行的事它的分身照常處理；要主線決定的，等它回來才會看到。')
  mailAnswer = { id: 7003, stored: true }
  expect((await call({ line: 'mail', to: 'eve', title: '備份', ask: '今天內確認', text: 'WO164 g11' })).text).toBe('已放進 eve 的信箱（#7003）。它一小時內會知道有信；讀了沒用 mail_sent 查。')
}, 30000)
