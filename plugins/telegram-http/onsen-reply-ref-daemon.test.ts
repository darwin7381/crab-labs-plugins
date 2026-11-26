// WO-175 item 2, the agent-inbox daemon's half end to end: a real agent-inbox daemon (server.ts, lanes on, ONSEN_SEND) against a stand-in Onsen (onsen5.py's
// /send: refs is a key → value object; an Onsen that does not know a key answers 400 「unknown field … in refs」) and a stand-in Telegram daemon (its
// router's /lanes/call-answered, the one place that knows which Call a reply_to names). No BTCC here: an item answered has no BTCC number, as on the lab.
//   a lane's reply (the router's /lanes/send with `call`): /send's refs.call is that call id; reply_to an event id (not a number) gives no
//   payload.reply_to_id; a BTCC number gives both; no call → no refs.call
//   the main's send_to_agent with reply_to: the daemon asks the router which Call that names (as the main gave it) and sends it as refs.call; nothing
//   named → none
//   an Onsen that does not take refs.call yet: the send goes once more without it (stored, not failed), counted, said once in the log
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { until, freePort } from './test-fixtures/tg-daemon.ts'

const CRED = 'mesh_REPLYREFsecretSECRETsecretSECRET012345'
const REF_KEYS = ['btcc_msg_id', 'run_id', 'ticket', 'alert', 'thread', 'op', 'form', 'schedule', 'run', 'incident', 'conversation']
let oldOnsen = false
const sends: any[] = [], asked: any[] = []
let seq = 0
const callOf: Record<string, string> = { '12601': '424', 'm-mwxajn16-1': '431' }      // what the router answers for a reply_to (as the main gave it)
let onsen: ReturnType<typeof Bun.serve>, tg: ReturnType<typeof Bun.serve>
let root = '', port = 0, proc: { kill(): void; exited: Promise<number> } | null = null, client: Client | null = null
const logOf = () => { try { return readFileSync(join(root, 'ws', '.agent-inbox-state', 'server.log'), 'utf8') } catch { return '' } }
const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()).catch(() => null) as Promise<any>

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onsen-reply-ref-'))
  onsen = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\/api\/onsen/, '')
    if (req.headers.get('authorization') !== `Bearer ${CRED}`) return Response.json({ detail: 'auth' }, { status: 401 })
    if (path === '/send' && req.method === 'POST') {
      const b: any = await req.json()
      sends.push(b)
      const bad = Object.keys(b.refs ?? {}).filter(k => !(oldOnsen ? REF_KEYS : [...REF_KEYS, 'call']).includes(k)).sort()
      if (bad.length) return Response.json({ detail: `unknown ${bad.length === 1 ? 'field' : 'fields'} ${bad.join(', ')} in refs; allowed: ${REF_KEYS.join(', ')}` }, { status: 400 })
      return Response.json({ results: [{ to: b.to, seq: ++seq, duplicate: false, pulling: true }] })
    }
    return Response.json({ detail: 'no route' }, { status: 404 })
  } })
  tg = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const path = new URL(req.url).pathname
    const b: any = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    if (path === '/lanes/call-answered') { asked.push(b); return Response.json({ call: b.to === 'chiron' ? callOf[String(b.reply_to)] ?? null : null }) }
    return Response.json({})
  } })
  const home = join(root, 'home'), ws = join(root, 'ws'), stateDir = join(ws, '.agent-inbox-state')
  for (const d of [home, ws, stateDir, join(root, 'tok')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(stateDir, 'mesh-credential'), CRED + '\n')
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ chiron: { url: 'http://127.0.0.1:9/inject' }, eve: { url: 'http://127.0.0.1:9/inject' }, adam: { url: 'http://127.0.0.1:9/inject' } }))
  port = await freePort()
  proc = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? '', HOME: home, CHANNEL_INBOX_ONLY: '1', TELEGRAM_HTTP_PORT: String(port), TELEGRAM_STATE_DIR: stateDir, AGENT_WORKSPACE_DIR: ws,
      MCP_READY_DELAY_MS: '200', CRAB_LABS_PLUGINS_ENV: join(root, 'no-machine-config'), HUB_SYNC: '0', USAGE_WALL_READ: '0', TYPESAFE_KEY_FILE: '/nonexistent/typesafe.env',
      ONSEN_BASE: `http://127.0.0.1:${onsen.port}/api/onsen`, ONSEN_SEND: 'adam', AGENT_INBOX_SELF: 'adam', GENESIS_LANES: '1', LANES_AGENT: 'adam',
      LANES_TG_PORT: String(tg.port), LANES_DIR: join(root, 'lanes'), MCP_TOKEN_DIR: join(root, 'tok'), AGENT_INBOX_REGISTRY: join(root, 'registry.json') },
    stdout: 'ignore', stderr: 'ignore',
  })
  if (!await until(async () => (await health())?.ok === true, 20000)) throw new Error('the agent-inbox daemon did not start')
  client = new Client({ name: 'reply-ref-main', version: '0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
}, 60000)
afterAll(async () => { try { await client?.close() } catch {}; try { proc?.kill() } catch {}; onsen?.stop(true); tg?.stop(true) })

/** what the Telegram daemon's router sends for a lane's reply_agent (lanes.ts reply_agent → laneMeshSend → /lanes/send) */
async function laneSend(body: Record<string, unknown>): Promise<any> {
  const tok = readFileSync(join(root, 'tok', String(port)), 'utf8').trim()
  const r = await fetch(`http://127.0.0.1:${port}/lanes/send`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ lane: 'adam.reflex.38', owner: 'adam.reflex.38', thread: 'adam#t-0cc100', hop: 1, turn_id: 'adam.reflex.38.r1', line: 'call', ...body }) })
  expect(r.status).toBe(200)
  return r.json()
}
const lastSend = () => sends.at(-1)

test('a lane\'s reply naming its Call: /send carries refs.call; reply_to an event id gives no reply_to_id, a BTCC number gives both; none named, no refs.call', async () => {
  const a = await laneSend({ to: 'chiron', text: '23 × 7 = 161', reply_to: 'mesh-1795681792065-0cc1', no_reply: true, call: '422' })
  expect(a.delivered).toBe(true)
  expect(lastSend()).toMatchObject({ to: 'chiron', kind: 'peer_call', refs: { call: '422', thread: 'adam#t-0cc100' }, no_reply: true })
  expect(lastSend().payload.reply_to_id).toBeUndefined()
  expect(lastSend().payload.text).toBe('23 × 7 = 161')
  await laneSend({ to: 'chiron', text: '23 × 8 = 184', reply_to: '12601', no_reply: true, call: '424' })
  expect(lastSend()).toMatchObject({ refs: { call: '424' }, payload: { reply_to_id: 12601, no_reply: true } })
  await laneSend({ to: 'chiron', text: '一則新的呼叫', because: 'chiron 在等' })
  expect(lastSend().refs?.call).toBeUndefined()
  await laneSend({ to: 'chiron', text: '不是號碼的 call', reply_to: 'x', no_reply: true, call: 'not-a-number' })
  expect(lastSend().refs?.call).toBeUndefined()
})

test('the main\'s send_to_agent with reply_to: the daemon asks the router which Call that names, as the main gave it; refs.call when one, none otherwise', async () => {
  const send = async (args: Record<string, unknown>) => String(((await client!.callTool({ name: 'send_to_agent', arguments: args })) as any).content?.[0]?.text ?? '')
  const k = asked.length
  expect(await send({ line: 'call', to: 'chiron', reply_to: '12601', text: '161' })).toMatch(/^delivered/)
  expect(asked.slice(k)).toEqual([{ to: 'chiron', reply_to: '12601' }])
  expect(lastSend()).toMatchObject({ to: 'chiron', refs: { call: '424' }, payload: { reply_to_id: 12601, no_reply: true }, no_reply: true })
  // the did of its delivery (not a number: a call that is no answer to fleet-mail's rule, so it needs a because) still names the Call
  expect(await send({ line: 'call', to: 'chiron', reply_to: 'm-mwxajn16-1', because: 'chiron 在等結果', text: '161' })).toMatch(/^delivered/)
  expect(asked.at(-1)).toEqual({ to: 'chiron', reply_to: 'm-mwxajn16-1' })
  expect(lastSend().refs).toMatchObject({ call: '431' })
  expect(lastSend().payload.reply_to_id).toBeUndefined()
  const n = asked.length
  expect(await send({ line: 'call', to: 'eve', because: 'eve 在等', text: '新的事' })).toMatch(/^delivered/)
  expect(asked.length).toBe(n)                                                              // no reply_to: nothing to ask
  expect(lastSend().refs?.call).toBeUndefined()
  expect(await send({ line: 'call', to: 'eve', reply_to: '12601', text: '回 eve' })).toMatch(/^delivered/)
  expect(lastSend().refs?.call).toBeUndefined()                                             // the router names no Call of eve's
}, 30000)
