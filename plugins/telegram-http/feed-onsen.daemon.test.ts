// WO-167: FEED_ONSEN. Two real agent-inbox daemons (server.ts, CHANNEL_INBOX_ONLY=1, a real MCP client as the session) against one stand-in
// Fleet Core: FEED_ONSEN=1 sends every wall call (send_to_agent line=feed, feed_ask and its read mark, feed_search, feed_open and its read mark,
// the tool list's /me) to /api/onsen/feed/*; the other (unset) sends them to /api/feed/* exactly as before. Same credential, same bodies, and
// the texts the agent reads are the same on both. Nothing leaves the machine.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'fs'
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

type Daemon = { port: number; proc: { kill(): void }; client: Client; agent: string }
const root = mkdtempSync(join(tmpdir(), 'feed-onsen-'))
const hits: { agent: string; method: string; path: string; body: any }[] = []
let stub: any, on: Daemon, off: Daemon

const CARD = { id: 300645, legacy_id: 646, time: '2026-11-25T19:21:00+00:00', author: 'epeius', source: 'agent', title: 'Mac mini: TUIs dropped', touches: ['tmux'],
  ref: null, supersedes: null, superseded_by: null, superseded_by_author: null }
function answer(path: string): any {
  const p = path.replace('/api/onsen/feed', '/api/feed')
  if (p === '/api/feed/me') return { name: 'x', ask: true, post: true }
  if (p === '/api/feed/posts') return { id: 300700, time: '2026-11-25T22:00:00+00:00', title: 't', supersedes: null }
  if (p === '/api/feed/ask') return { candidates: 3, judged: 3, related: 1, more: 0, unjudged: 0, jev: 'ok', given: [{ ...CARD, body: '全文 #646', links: [], read: false }] }
  if (p === '/api/feed/search') return { total: 1, shown: 1, cards: [{ ...CARD, read: false }] }
  if (p === '/api/feed/read') return { marked: 1 }
  if (/^\/api\/feed\/posts\/\d+$/.test(p)) return { ...CARD, body: '全文 #646', links: [], read: false }
  return {}
}

async function boot(name: string, extra: Record<string, string>): Promise<Daemon> {
  const home = join(root, name, 'home'), ws = join(root, name, 'ws'), stateDir = join(ws, '.agent-inbox-state'), tokDir = join(root, name, 'tok')
  for (const d of [home, ws, stateDir, tokDir]) mkdirSync(d, { recursive: true })
  const port = await freePort()
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    cwd: import.meta.dir,
    env: {
      PATH: process.env.PATH ?? '', HOME: home, CHANNEL_INBOX_ONLY: '1', TELEGRAM_HTTP_PORT: String(port), TELEGRAM_STATE_DIR: stateDir,
      AGENT_INBOX_SELF: name, AGENT_WORKSPACE_DIR: ws, MCP_TOKEN_DIR: tokDir, BTCC_API_BASE: `http://127.0.0.1:${stub.port}`,
      FLEET_CORE_BASE: `http://127.0.0.1:${stub.port}`, MCP_READY_DELAY_MS: '200', CRAB_LABS_PLUGINS_ENV: join(root, 'no-machine-config'),
      HUB_SYNC: '0', USAGE_WALL_READ: '0', TYPESAFE_KEY_FILE: '/nonexistent/typesafe.env', ...extra,
    },
    stdout: 'ignore', stderr: 'ignore',
  })
  const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()).catch(() => null)
  expect(await until(async () => (await health())?.ok === true, 15000)).toBe(true)
  const client = new Client({ name: `feed-onsen-${name}`, version: '0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
  await sleep(400)                                            // past MCP_READY_DELAY_MS
  return { port, proc, client, agent: name }
}

beforeAll(async () => {
  stub = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(r) {
    const u = new URL(r.url)
    const body = r.method === 'POST' ? await r.json().catch(() => ({})) : undefined
    const agent = String(r.headers.get('user-agent') ?? '').replace('agent-inbox/', '')
    if (u.pathname.startsWith('/api/feed') || u.pathname.startsWith('/api/onsen/feed')) hits.push({ agent, method: r.method, path: u.pathname + u.search, body })
    return Response.json(answer(u.pathname))
  } })
  on = await boot('adam', { FEED_ONSEN: '1' })
  off = await boot('eve', {})
}, 45000)

afterAll(async () => {
  for (const d of [on, off]) { try { await d?.client.close() } catch {}; try { d?.proc.kill() } catch {} }
  stub?.stop(true)
})

async function use(d: Daemon): Promise<{ texts: string[]; tools: string[] }> {
  const tools = (await d.client.listTools()).tools.map(t => t.name)
  const texts: string[] = []
  for (const [name, args] of [
    ['send_to_agent', { line: 'feed', title: 'Adam：牆搬進 Onsen', text: '全文', touches: ['onsen'], ref: 'WO-167', supersedes: 646 }],
    ['feed_ask', { about: '要動 Mac mini 的 tmux' }],
    ['feed_search', { q: 'mac mini' }],
    ['feed_open', { id: 646 }],
  ] as const) {
    const r: any = await d.client.callTool({ name, arguments: args as any })
    texts.push(String(r.content?.[0]?.text ?? ''))
  }
  await until(() => hits.filter(h => h.agent === d.agent && h.path.endsWith('/read')).length >= 2, 6000)   // the read marks run 1.5 s after the answer
  return { texts, tools }
}

test('FEED_ONSEN=1: every wall call goes to /api/onsen/feed; unset: /api/feed as before; same bodies, same texts', async () => {
  const a = await use(on), e = await use(off)
  const of = (agent: string) => hits.filter(h => h.agent === agent).map(h => `${h.method} ${h.path}`)
  const seenOn = of('adam'), seenOff = of('eve')
  expect(seenOn.length).toBeGreaterThanOrEqual(7)
  expect(seenOn.every(x => x.includes(' /api/onsen/feed/'))).toBe(true)
  expect(seenOff.every(x => x.includes(' /api/feed/') && !x.includes('/api/onsen/'))).toBe(true)
  for (const want of ['POST /api/onsen/feed/posts', 'POST /api/onsen/feed/ask', 'GET /api/onsen/feed/search?q=mac%20mini&limit=20', 'GET /api/onsen/feed/posts/646',
    'GET /api/onsen/feed/me']) expect(seenOn).toContain(want)
  expect(seenOn.filter(x => x === 'POST /api/onsen/feed/read').length).toBe(2)
  expect([...seenOn].sort()).toEqual([...seenOff].map(x => x.replace(' /api/feed/', ' /api/onsen/feed/')).sort())
  const bodies = (agent: string) => hits.filter(h => h.agent === agent).map(h => JSON.stringify(h.body ?? null)).sort()
  expect(bodies('adam')).toEqual(bodies('eve'))
  expect(hits.find(h => h.agent === 'adam' && h.path.endsWith('/posts'))?.body).toMatchObject({ title: 'Adam：牆搬進 Onsen', body: '全文', touches: ['onsen'], ref: 'WO-167', supersedes: 646 })
  expect(hits.filter(h => h.agent === 'adam' && h.path.endsWith('/read')).map(h => h.body)).toEqual([{ ids: [300645], via: 'ask' }, { ids: [646], via: 'open' }])
  expect(a.texts).toEqual(e.texts)
  expect(a.tools).toEqual(e.tools)
  expect(a.tools).toContain('feed_ask')
  expect(a.texts[0]).toContain('已貼出 #300700')
  expect(a.texts[3]).toContain('#300645｜')
}, 30000)
