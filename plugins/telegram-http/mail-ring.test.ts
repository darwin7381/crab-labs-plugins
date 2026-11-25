// WO-141 phase 2: BTCC's mailbox ring (POST /inject {wake: 'mail', ring: true} through the oncall receiver) wakes the agent's mail lane and nothing
// else. Router (this process, role tg): lanes on → the mail lane, coalesced while it runs; lanes switched off (/lanes off) → recorded, not the main's.
// Daemon (a real agent-inbox daemon, server.ts CHANNEL_INBOX_ONLY=1, a real MCP client as the session): lanes off → dropped with an `ignored` answer,
// no BTCC comms row, the session sees nothing, while the watchdog's 讀信箱 reminder (wake mail, no ring) still reaches the session; lanes on → the
// router gets the event with wake and ring; router unreachable → not delivered (no fallback to the session), answered not injected.
import { test, expect, beforeAll, afterAll, describe } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, chmodSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await sleep(30) }
  return fn()
}
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) })
    s.on('error', rej)
  })
}
const RING_TEXT = '讀信箱（2 封未讀，最舊的等了 3 分鐘）：先用 mailbox_list（mcp__plugin_agent-inbox_agent-inbox__mailbox_list）看清單'
const KW_TEXT = '讀信箱（1 封未讀，最舊的等了 61 分鐘）：先用 mailbox_list（mcp__plugin_agent-inbox_agent-inbox__mailbox_list）看清單'

// ------------------------------------------------------------------ the router (lanes.ts, role tg)
process.env.LANES_FLOOD_CONTROL = '0'
const L = await import('./lanes.ts?mail-ring') as typeof import('./lanes.ts')
const dir = mkdtempSync(join(tmpdir(), 'mail-ring-'))
process.env.LANES_DIR = dir
copyFileSync(process.env.LANES_TEST_ROUTER ?? '/home/god/genesis/universes/002/router.json', join(dir, 'router.json'))
const GO = join(dir, 'go'), bin = join(dir, 'lane.py')
writeFileSync(bin, `#!/usr/bin/env python3
import json, os, time
open('${dir}/prompts.log', 'a').write('run\\n')
t0 = time.time()
while time.time() - t0 < 30 and not os.path.exists('${GO}'): time.sleep(0.02)
try: os.remove('${GO}')
except OSError: pass
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'ok'}), flush=True)
`)
chmodSync(bin, 0o755)
const restoreBin = L.__setClaudeBin(bin)
L.__setMailTool(async () => ({ text: '0 封未讀', isError: false }))
L.lanesInit({ role: 'tg', agent: 'adam', workspaceDir: dir, transcriptDir: dir, httpPort: 0, log: () => {}, deliverToMain: () => {}, authOk: () => false,
  registryNames: () => ['eve'], sendBot: async () => 1, joeyChatId: () => '1' } as any)
let n = 0
const ringEv = () => ({ id: `mesh-ring-${++n}`, source: 'mesh', from: 'mailbox', verified: true, text: RING_TEXT, no_reply: true, wake: 'mail', line: 'mail',
  meta: { no_reply: 'true', ring: 'true', wake: 'mail', line: 'mail' }, notif: { method: 'notifications/claude/channel', params: { content: RING_TEXT, meta: {} } } } as any)
const kwEv = () => ({ id: `mesh-kw-${++n}`, source: 'mesh', from: 'fleet-watchdog', verified: true, text: KW_TEXT, no_reply: true, wake: 'mail', line: 'mail',
  meta: { no_reply: 'true', wake: 'mail' }, notif: { method: 'notifications/claude/channel', params: { content: KW_TEXT, meta: {} } } } as any)
const routing = (): any[] => { try { return readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch { return [] } }
const runs = (): number => { try { return readFileSync(join(dir, 'prompts.log'), 'utf8').trim().split('\n').filter(Boolean).length } catch { return 0 } }
const done = async (lane: string) => { writeFileSync(GO, 'ok'); await until(() => !L.__runTok(lane)); await sleep(30) }

describe('router', () => {
  test('lanes switched off: a ring is recorded and reaches no one; the watchdog\'s reminder (no ring) still goes to the main', async () => {
    const S = L.__lanesState()
    S.master_off = { since: new Date().toISOString(), by: 'test' }
    try {
      const ev = ringEv()
      const d = await L.routeEvent(ev)
      expect(d).toMatchObject({ rule: 'master-off-ring', target: 'ledger' })
      expect(routing().find(r => r.event === ev.id)).toMatchObject({ rule: 'master-off-ring', target: 'ledger', wake: 'mail' })
      expect(L.__journal().rows('msg', r => r.event === ev.id).length).toBe(0)            // no M1 item: the main is not woken
      const kw = kwEv()
      expect(await L.routeEvent(kw)).toMatchObject({ rule: 'master-off', target: 'main' })
      expect(L.__journal().rows('msg', r => r.event === kw.id).length).toBe(1)
    } finally { delete S.master_off }
  })

  test('lanes on: a ring dispatches the mail lane; rings while it runs make ONE follow-up run', async () => {
    const d1 = await L.routeEvent(ringEv())
    expect(d1).toMatchObject({ rule: 'wake-mail', target: 'lane' })
    const lane = d1.lane!
    expect(L.__lanesState().lanes[lane].kind).toBe('mail')
    expect(await until(() => !!L.__runTok(lane))).toBe(true)
    const d2 = await L.routeEvent(ringEv())                 // the run in progress may have listed the mailbox before this mail: one run after it
    const d3 = await L.routeEvent(ringEv())                 // a run already waits: it reads the whole mailbox
    const d4 = await L.routeEvent(kwEv())                   // the watchdog's safety-net reminder too
    expect(d2).toMatchObject({ target: 'lane', lane })
    expect(d3).toMatchObject({ rule: 'wake-mail', target: 'ledger', lane }); expect(d3.note).toContain('already waiting')
    expect(d4).toMatchObject({ rule: 'wake-mail', target: 'ledger', lane })
    await done(lane)
    expect(await until(() => !!L.__runTok(lane))).toBe(true)
    await done(lane)
    await sleep(300)
    expect(runs()).toBe(2)                                  // four wake-ups, two runs
    expect(L.__journal().rows('msg', r => String(r.event ?? '').startsWith('mesh-ring-')).length).toBe(0)   // the main never saw one
  }, 20000)
})

// ------------------------------------------------------------------ the agent-inbox daemon (server.ts /inject)
type Daemon = { port: number; proc: { kill(): void }; client: Client; received: string[] }
const root = mkdtempSync(join(tmpdir(), 'mail-ring-daemon-'))
const comms: any[] = [], routed: any[] = []
let stub: any, tg: any, off: Daemon, on: Daemon

async function boot(name: string, extra: Record<string, string>): Promise<Daemon> {
  const home = join(root, name, 'home'), ws = join(root, name, 'ws'), stateDir = join(ws, '.agent-inbox-state'), tokDir = join(root, name, 'tok')
  for (const d of [home, ws, stateDir, tokDir]) mkdirSync(d, { recursive: true })
  const port = await freePort()
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    cwd: import.meta.dir,
    env: {
      PATH: process.env.PATH ?? '', HOME: home, CHANNEL_INBOX_ONLY: '1', TELEGRAM_HTTP_PORT: String(port), TELEGRAM_STATE_DIR: stateDir,
      AGENT_INBOX_SELF: 'adam', AGENT_WORKSPACE_DIR: ws, MCP_TOKEN_DIR: tokDir, BTCC_API_BASE: `http://127.0.0.1:${stub.port}`,
      FLEET_CORE_BASE: `http://127.0.0.1:${stub.port}`, MCP_READY_DELAY_MS: '200', CRAB_LABS_PLUGINS_ENV: join(root, 'no-machine-config'),
      HUB_SYNC: '0', USAGE_WALL_READ: '0', TYPESAFE_KEY_FILE: '/nonexistent/typesafe.env', ...extra,
    },
    stdout: 'ignore', stderr: 'ignore',
  })
  const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()).catch(() => null)
  expect(await until(async () => (await health())?.ok === true, 15000)).toBe(true)
  const received: string[] = []
  const client = new Client({ name: `mail-ring-${name}`, version: '0' }, { capabilities: {} })
  client.fallbackNotificationHandler = async nn => {
    if (nn.method === 'notifications/claude/channel') received.push(String((nn.params as { content?: unknown })?.content))
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
  expect(await until(async () => (await health())?.sessions_with_open_sse === 1)).toBe(true)
  await sleep(400)                                            // past MCP_READY_DELAY_MS
  return { port, proc, client, received }
}
const inject = (d: Daemon, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${d.port}/inject`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
const RING = { text: RING_TEXT, from: 'mailbox', wake: 'mail', ring: true, no_reply: true, line: 'mail' }    // no logged:true: a ring is never logged anyway
const KW = { text: KW_TEXT, from: 'fleet-watchdog', wake: 'mail', no_reply: true, logged: true }

beforeAll(async () => {
  stub = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(r) {
    const u = new URL(r.url)
    if (u.pathname === '/api/comms/log') { comms.push(await r.json().catch(() => ({}))); return Response.json({ id: 9000 + comms.length }) }
    return Response.json({})
  } })
  tg = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(r) {
    const u = new URL(r.url)
    if (u.pathname === '/lanes/route') { routed.push(await r.json()); return Response.json({ rule: 'wake-mail', target: 'lane', lane: 'adam.mail.1' }) }
    return Response.json({})
  } })
  off = await boot('off', {})
  on = await boot('on', { GENESIS_LANES: '1', LANES_AGENT: 'adam', LANES_TG_PORT: String(tg.port), LANES_DIR: join(root, 'on', 'lanes') })
}, 45000)

afterAll(async () => {
  for (const d of [off, on]) { try { await d?.client.close() } catch {}; try { d?.proc.kill() } catch {} }
  stub?.stop(true); tg?.stop(true)
  try { writeFileSync(GO, 'ok') } catch {}
  L.__setClaudeBin(restoreBin); L.__setMailTool(null); delete process.env.LANES_FLOOD_CONTROL
})

describe('daemon', () => {
  test('lanes off: a ring is dropped (ignored, no comms row, nothing in the session); the watchdog\'s reminder and a message still arrive', async () => {
    const r = await inject(off, RING)
    expect(r).toMatchObject({ injected: false, ignored: expect.stringContaining('lanes off') })
    const k = await inject(off, KW)
    expect(k.injected).toBe(true)
    expect(await until(() => off.received.includes(KW_TEXT))).toBe(true)
    const m = await inject(off, { text: 'eve 的一則訊息', from: 'eve' })
    expect(m.injected).toBe(true)
    expect(await until(() => off.received.includes('eve 的一則訊息'))).toBe(true)
    await sleep(300)
    expect(off.received).not.toContain(RING_TEXT)
    expect(comms.map(c => c.body)).toEqual(['eve 的一則訊息'])           // the message is logged; the ring is not (and the reminder said logged)
    // ring:true without wake=mail is no ring: an ordinary inject
    const odd = await inject(off, { text: 'ring but no wake', from: 'eve', ring: true })
    expect(odd.injected).toBe(true)
    expect(await until(() => off.received.includes('ring but no wake'))).toBe(true)
  }, 20000)

  test('lanes on: the router gets the ring with wake and ring; no comms row; the session sees nothing', async () => {
    const before = comms.length
    const r = await inject(on, RING)
    expect(r).toMatchObject({ injected: true, routed: 'lane', lane: 'adam.mail.1' })
    const ev = routed.at(-1)
    expect(ev).toMatchObject({ from: 'mailbox', text: RING_TEXT, wake: 'mail', line: 'mail', no_reply: true })
    expect(ev.meta).toMatchObject({ ring: 'true', wake: 'mail', line: 'mail', no_reply: 'true' })
    await sleep(300)
    expect(comms.length).toBe(before)
    expect(on.received).toEqual([])
  }, 20000)

  test('lanes on, no router to ask: the ring is not delivered and not handed to the session; the watchdog\'s reminder keeps its fallback', async () => {
    tg.stop(true)
    await sleep(100)
    const r = await inject(on, RING)
    expect(r).toMatchObject({ injected: false, error: expect.stringContaining('router unreachable') })
    await sleep(600)
    expect(on.received).toEqual([])
    const k = await inject(on, KW)                         // unchanged: a reminder without ring falls back to the session (the fleet path)
    expect(k.injected).toBe(true)
    expect(await until(() => on.received.includes(KW_TEXT))).toBe(true)
  }, 20000)
})
