// Telegram HTTP and agent-inbox daemons never own a Telegram poll.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { startBotApiMock, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { freePort, until, sleep } from './test-fixtures/tg-daemon.ts'

const PLUGIN = import.meta.dir
const PLUGINS = join(PLUGIN, '..')
const PROBE = join(PLUGIN, 'test-fixtures', 'no-telegram-probe.ts')
const JOEY = 1828
let root = ''
const apis: BotApiMock[] = []
const procs: Array<ReturnType<typeof Bun.spawn>> = []
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'wo197-final-')) })
afterAll(async () => { for (const p of procs) { try { p.kill() } catch {} } await Promise.all(procs.map(p => p.exited.catch(() => {}))); for (const a of apis) a.stop() })

const health = (port: number) => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()).catch(() => null) as Promise<any>
/** a daemon as launchd runs it (no fixture defaults): its env exactly `env` plus PATH and HOME */
async function spawnDaemon(name: string, entry: string, env: Record<string, string>, o: { probe?: boolean; machine?: string } = {}) {
  const dir = join(root, name), home = join(dir, 'home'), ws = join(dir, 'ws'), state = join(ws, '.telegram-state')
  for (const d of [home, ws, state]) mkdirSync(d, { recursive: true })
  writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(JOEY)], groups: {}, pending: {}, ackReaction: '' }))
  if (o.machine != null) writeFileSync(join(dir, 'machine-config'), o.machine)
  const port = await freePort(), probeOut = join(dir, 'probe.txt')
  const proc = Bun.spawn([process.execPath, '--no-env-file', ...(o.probe ? ['--preload', PROBE] : []), entry], {
    cwd: PLUGIN, stdout: 'pipe', stderr: 'pipe',
    env: { GIT_ALLOW_PROTOCOL: 'file', ONSEN_BASE: 'http://127.0.0.1:1', ONSEN_REGISTRY_CLI: '0', PATH: process.env.PATH ?? '', HOME: home, TELEGRAM_HTTP_PORT: String(port), TELEGRAM_STATE_DIR: state, AGENT_WORKSPACE_DIR: ws,
      CRAB_LABS_PLUGINS_ENV: join(dir, 'machine-config'), HUB_SYNC: '0', USAGE_WALL_READ: '0', MCP_TOKEN_DIR: join(dir, 'tok'), PROBE_OUT: probeOut,
      TMUX_TMPDIR: join(dir, 'tmux'), ...env },
  })
  procs.push(proc)
  return { dir, home, ws, state, port, proc, probeOut, log: () => { try { return readFileSync(join(state, 'server.log'), 'utf8') } catch { return '' } } }
}

test('(a) no bot token anywhere: the daemon starts and is a connector; nothing of Telegram is loaded', async () => {
  const d = await spawnDaemon('a', join(PLUGIN, 'server.ts'), { GENESIS_LANES: '0' }, { probe: true, machine: '' })
  expect(await until(async () => (await health(d.port))?.ok === true, 20000)).toBe(true)
  const h = await health(d.port)
  expect(h.connector.on).toBe(true)
  expect(h.connector.roamer).toBe(false)
  expect(h.connector.token).toBe(false)
  expect(h.connector.bot_api_refused).toEqual({})
  expect(h.polling).toBe(false)
  expect(h.bot_username).toBe(null)
  expect('version' in h).toBe(true)
  expect(await until(async () => typeof (await health(d.port))?.version === 'string', 15000)).toBe(true)   // read from git / package.json after start
  expect(d.log()).toContain('connector mode')
  expect(d.log()).not.toContain('TELEGRAM_BOT_TOKEN required')
  expect(existsSync(d.probeOut)).toBe(false)                                       // grammy / roamer-telegram.ts never loaded
  expect(d.proc.exitCode).toBe(null)
}, 40000)

test('(a) ONSEN_BRIDGE is no switch: off in the plist, off in the machine config, or naming someone else; a token in the env: still a connector, Telegram untouched', async () => {
  const api = startBotApiMock({}, { pollHoldMs: 200 }); apis.push(api)
  const base = { GENESIS_LANES: '0', TELEGRAM_BOT_TOKEN: api.token, TELEGRAM_API_ROOT: api.url }
  const a = await spawnDaemon('a2', join(PLUGIN, 'server.ts'), { ...base, ONSEN_BRIDGE: '0' }, { probe: true })
  const b = await spawnDaemon('a3', join(PLUGIN, 'server.ts'), base, { probe: true, machine: 'ONSEN_BRIDGE=someone-else\n' })
  const c = await spawnDaemon('a4', join(PLUGIN, 'server.ts'), { ...base, ONSEN_BRIDGE: 'nobody' }, { probe: true })
  for (const d of [a, b, c]) {
    expect(await until(async () => (await health(d.port))?.ok === true, 20000)).toBe(true)
    const h = await health(d.port)
    expect(h.connector).toMatchObject({ on: true, roamer: false, token: true, bot_api_refused: {} })
    expect(h.polling).toBe(false)
    expect(existsSync(d.probeOut)).toBe(false)
  }
  await sleep(1500)
  expect(api.calls).toEqual([])
  expect(api.polls).toEqual([])
}, 60000)

/** every .ts of telegram-http and agent-inbox that is not a test, a test fixture, or telegram-bridge/ (another program) */
function daemonSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      if (n === 'node_modules' || n === 'test-fixtures' || n === 'telegram-bridge') continue
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (n.endsWith('.ts') && !n.endsWith('.test.ts')) out.push(p)
    }
  }
  walk(join(PLUGINS, 'telegram-http'))
  walk(join(PLUGINS, 'agent-inbox'))
  return out.sort()
}
test('the daemon sources have no native Telegram client or poll', () => {
  const files = daemonSources()
  expect(files).toContain(join(PLUGIN, 'server.ts'))
  expect(files).toContain(join(PLUGINS, 'agent-inbox', 'server.ts'))
  expect(existsSync(join(PLUGIN, 'roamer-telegram.ts'))).toBe(false)
  const hits = files.filter(f => /from ['"]grammy|api\.telegram\.org|bot\.api\.|getUpdates/.test(readFileSync(f, 'utf8')))
  expect(hits.map(f => relative(PLUGINS, f))).toEqual([])
})

test('a roamer with a configured token still leaves the bot to the bridge', async () => {
  const api = startBotApiMock({}); apis.push(api)
  const d = await spawnDaemon('roamer', join(PLUGIN, 'server.ts'), { ROAMER_MODE: '1', ROAMER_BOT_NAME: 'lab_test_bot',
    ONSEN_RECORD: '0', TELEGRAM_BOT_TOKEN: api.token, TELEGRAM_API_ROOT: api.url }, { probe: true })
  expect(await until(async () => (await health(d.port))?.ok === true)).toBe(true)
  expect(await health(d.port)).toMatchObject({ polling: false, connector: { on: true, roamer: true } })
  expect(existsSync(d.probeOut)).toBe(false)
  expect(api.calls).toEqual([])
  expect(api.polls).toEqual([])
}, 30000)

test('(d) the agent-inbox daemon (CHANNEL_INBOX_ONLY, the same engine) starts with the probe: no Telegram code loaded', async () => {
  const d = await spawnDaemon('d', join(PLUGINS, 'agent-inbox', 'server.ts'), { AGENT_INBOX_SELF: 'adam' }, { probe: true })
  expect(await until(async () => (await health(d.port))?.ok === true, 20000)).toBe(true)
  const h = await health(d.port)
  expect(h.plugin).toBe('telegram-http')
  expect('connector' in h).toBe(false)
  expect(h.polling).toBe(false)
  expect(existsSync(d.probeOut)).toBe(false)
  expect(d.log()).toContain('agent-inbox: serving mailbox')
  expect(d.proc.exitCode).toBe(null)
}, 40000)
