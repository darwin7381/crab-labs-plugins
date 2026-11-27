// WO-204: the lanes-off inbox daemon delivers through its open MCP stream during a wall and after the clear.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

describe('lanes-off daemon delivery', () => {
  test('no state: delivered at once (as before)', async () => {
    await inject('a0')
    expect(await until(() => received.includes('a0'))).toBe(true)
  }, 15000)

  test('walled: an open stream receives input immediately', async () => {
    writeState({})
    expect(await until(async () => (await health())?.usage_wall?.walled === true)).toBe(true)
    await inject('h1')
    expect(await until(() => received.includes('h1'))).toBe(true)
    expect(pending()).toBe(0)
    expect(existsSync(heldFile)).toBe(false)
  }, 15000)

  test('clear: the previously delivered input is not replayed', async () => {
    const since = JSON.parse(readFileSync(statePath, 'utf8')).since
    writeState({ since, in_wall: false, cleared_at: new Date().toISOString(), cleared_by: 'probe_after_reset' })
    expect(await until(async () => (await health())?.usage_wall?.walled === false)).toBe(true)
    await inject('after')
    expect(await until(() => received.includes('after'))).toBe(true)
    expect(received).toEqual(['a0', 'h1', 'after'])
    expect(pending()).toBe(0)
    expect(existsSync(heldFile)).toBe(false)
  }, 15000)

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
