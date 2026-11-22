// WO-120 end to end: a real agent-inbox daemon (server.ts, CHANNEL_INBOX_ONLY=1) with a temp HOME, a real MCP client
// as the session, and a usage-wall state file this test writes the way usage_wall.py does.
//   walled  → /inject items park in inbox/pending, nothing reaches the session, a delivery the wall ate is re-persisted,
//             nothing quarantined, the held sidecar says how many;
//   cleared → each held item reaches the session once, in order; the sidecar stays with count 0;
//   stale / OFF → delivered at once, as before.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const root = mkdtempSync(join(tmpdir(), 'uw-daemon-'))
const home = join(root, 'home')
const ws = join(root, 'ws')
const stateDir = join(ws, '.agent-inbox-state')
const wallDir = join(root, 'usage-wall')
const tdir = join(home, '.claude', 'projects', ws.replace(/[^a-zA-Z0-9]/g, '-'))
const transcript = join(tdir, 's1.jsonl')
const pendingDir = join(stateDir, 'inbox', 'pending')
const undeliverableDir = join(stateDir, 'inbox', 'undeliverable')
const statePath = join(wallDir, 'claude-wallbot.json')
const heldFile = join(wallDir, 'claude-wallbot.held-inbox.json')
const EPISODE = 'wallbot-20261123T080000Z'

let port = 0
let proc: { kill(): void } | null = null
let client: Client | null = null
const received: string[] = []

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await sleep(50) }
  return false
}
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) })
    s.on('error', rej)
  })
}
function writeState(over: Record<string, unknown>): void {
  writeFileSync(statePath, JSON.stringify({
    agent: 'wallbot', tmux: 'claude-wallbot', session: 's1', transcript, in_wall: true, episode: EPISODE,
    since: new Date().toISOString(), kind: 'five_hour', text: "You've hit your session limit", resets_at: null,
    cleared_at: null, cleared_by: null, updated_at: new Date().toISOString(), ...over,
  }))
}
const inject = (text: string) => fetch(`http://127.0.0.1:${port}/inject`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, from: 'tester' }),
}).then(r => r.json())
const pending = () => { try { return readdirSync(pendingDir).filter(f => f.endsWith('.json')).length } catch { return 0 } }
const quarantined = () => { try { return readdirSync(undeliverableDir).length } catch { return 0 } }
const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()).catch(() => null)

beforeAll(async () => {
  for (const d of [home, stateDir, wallDir, tdir]) mkdirSync(d, { recursive: true })
  writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 60_000).toISOString(), message: { content: 'hi' } }) + '\n')
  port = await freePort()
  proc = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    cwd: import.meta.dir,
    env: {
      PATH: process.env.PATH ?? '', HOME: home, CHANNEL_INBOX_ONLY: '1', TELEGRAM_HTTP_PORT: String(port),
      TELEGRAM_STATE_DIR: stateDir, AGENT_INBOX_SELF: 'wallbot', USAGE_WALL_DIR: wallDir, USAGE_WALL_CACHE_MS: '200',
      MCP_READY_DELAY_MS: '200', CRAB_LABS_PLUGINS_ENV: join(root, 'no-machine-config'), HUB_SYNC: '0',
    },
    stdout: 'ignore', stderr: 'ignore',
  })
  expect(await until(async () => (await health())?.ok === true, 15000)).toBe(true)
  client = new Client({ name: 'wo120-test', version: '0' }, { capabilities: {} })
  client.fallbackNotificationHandler = async n => {
    if (n.method === 'notifications/claude/channel') received.push(String((n.params as { content?: unknown })?.content))
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
  expect(await until(async () => (await health())?.sessions_with_open_sse === 1)).toBe(true)
  await sleep(400)   // past MCP_READY_DELAY_MS
}, 30000)

afterAll(async () => {
  try { await client?.close() } catch {}
  try { proc?.kill() } catch {}
  await sleep(100)
  if (process.env.WO120_KEEP_TMP === '1') console.log(`kept ${root}`)
  else try { rmSync(root, { recursive: true, force: true }) } catch {}
})

describe('daemon: hold, then deliver once each', () => {
  test('no state: delivered at once (as before)', async () => {
    await inject('a0')
    expect(await until(() => received.includes('a0'))).toBe(true)
  }, 15000)

  test('walled: nothing reaches the session; held items park; the eaten one is re-persisted; nothing quarantined', async () => {
    // a0 was answered (a genuine record after it); e0 goes in just before the wall and is never answered
    appendFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
      message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }] } }) + '\n')
    await sleep(20)
    await inject('e0')
    expect(await until(() => received.includes('e0'))).toBe(true)
    await sleep(20)
    writeState({})
    expect(await until(() => existsSync(heldFile))).toBe(true)   // first wall seen: sidecar written
    expect(await until(() => pending() === 1)).toBe(true)        // e0 re-persisted (the wall ate it)
    for (const t of ['h1', 'h2', 'h3', 'h2']) expect((await inject(t)).injected).toBe(true)   // h2 re-sent: held once
    expect((await health())?.usage_wall).toMatchObject({ walled: true, episode: EPISODE, key: 'claude-wallbot' })
    await sleep(1200)
    expect(received).toEqual(['a0', 'e0'])
    expect(pending()).toBe(4)
    expect(quarantined()).toBe(0)
    writeState({ since: JSON.parse(readFileSync(statePath, 'utf8')).since })   // keeper heartbeat
    expect(await until(() => JSON.parse(readFileSync(heldFile, 'utf8')).count === 4)).toBe(true)
    const h = JSON.parse(readFileSync(heldFile, 'utf8'))
    expect(h).toMatchObject({ redelivers: true, role: 'inbox', episode: EPISODE, count: 4, held_at_clear: null })
  }, 20000)

  test('cleared: each held item once, in order; the sidecar stays, count 0', async () => {
    const since = JSON.parse(readFileSync(statePath, 'utf8')).since
    writeState({ since, in_wall: false, cleared_at: new Date().toISOString(), cleared_by: 'probe_after_reset' })
    expect(await until(() => received.length >= 6)).toBe(true)
    await sleep(1000)
    expect(received).toEqual(['a0', 'e0', 'e0', 'h1', 'h2', 'h3'])
    expect(pending()).toBe(0)
    expect(quarantined()).toBe(0)
    expect(await until(() => JSON.parse(readFileSync(heldFile, 'utf8')).count === 0)).toBe(true)
    const h = JSON.parse(readFileSync(heldFile, 'utf8'))
    expect(h).toMatchObject({ redelivers: true, count: 0, held_at_clear: 4, episode: EPISODE })
    expect(h.drained_at).toBeTruthy()
  }, 20000)

  test('stale state or OFF: delivered at once, as before', async () => {
    writeState({ episode: 'wallbot-2', updated_at: new Date(Date.now() - 200_000).toISOString() })
    await sleep(500)
    await inject('s1')
    expect(await until(() => received.includes('s1'))).toBe(true)
    writeState({ episode: 'wallbot-3' })
    writeFileSync(join(wallDir, 'OFF'), '')
    await sleep(500)
    await inject('s2')
    expect(await until(() => received.includes('s2'))).toBe(true)
    expect(pending()).toBe(0)
    rmSync(join(wallDir, 'OFF'))
  }, 15000)
})
