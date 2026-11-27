// WO-197 final (telegram-http 1.59.0, Chiron's ruling A): the Telegram code is roamer-telegram.ts, loaded only by a roamer (ROAMER_MODE=1).
//   (a) a non-roamer daemon starts with no bot token anywhere (env, state dir .env, machine config) and is a connector: /healthz connector.on true,
//       polling false, bot_username null, bot_api_refused {}; ONSEN_BRIDGE (plist or machine config, on or off) changes nothing; a token in its env is
//       not used (the Bot API stand-in sees nothing); grammy and roamer-telegram.ts are never loaded (test-fixtures/no-telegram-probe.ts)
//   (b) the search Chiron runs: no non-test .ts of telegram-http or agent-inbox but roamer-telegram.ts (and telegram-bridge/, a separate program)
//       mentions grammy, api.telegram.org, bot.api or getUpdates; server.ts loads roamer-telegram.ts once, by a dynamic import behind ROAMER only
//   (c) a roamer against the Bot API stand-in: polls, an update reaches its target session only (roamer-state.json's current_target), a reply goes
//       out to the stand-in; no target: told so on Telegram; no token: exits as before (code 1, the same lines); with the probe it cannot start
//   (d) the agent-inbox daemon (the same engine, CHANNEL_INBOX_ONLY) starts with the probe: no Telegram code loaded
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { freePort, until, sleep, startTgDaemon } from './test-fixtures/tg-daemon.ts'

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
async function spawnDaemon(name: string, entry: string, env: Record<string, string>, o: { probe?: boolean; machine?: string; stateEnv?: string } = {}) {
  const dir = join(root, name), home = join(dir, 'home'), ws = join(dir, 'ws'), state = join(ws, '.telegram-state')
  for (const d of [home, ws, state]) mkdirSync(d, { recursive: true })
  writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(JOEY)], groups: {}, pending: {}, ackReaction: '' }))
  if (o.machine != null) writeFileSync(join(dir, 'machine.env'), o.machine)
  if (o.stateEnv != null) writeFileSync(join(state, '.env'), o.stateEnv)
  const port = await freePort(), probeOut = join(dir, 'probe.txt')
  const proc = Bun.spawn(['bun', ...(o.probe ? ['--preload', PROBE] : []), entry], {
    cwd: PLUGIN, stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: home, TELEGRAM_HTTP_PORT: String(port), TELEGRAM_STATE_DIR: state, AGENT_WORKSPACE_DIR: ws,
      CRAB_LABS_PLUGINS_ENV: join(dir, 'machine.env'), HUB_SYNC: '0', USAGE_WALL_READ: '0', MCP_TOKEN_DIR: join(dir, 'tok'), PROBE_OUT: probeOut,
      TMUX_TMPDIR: join(dir, 'tmux'), ...env },
  })
  procs.push(proc)
  return { dir, home, ws, state, port, proc, probeOut, log: () => { try { return readFileSync(join(state, 'server.log'), 'utf8') } catch { return '' } } }
}

test('(a) no bot token anywhere: the daemon starts and is a connector; nothing of Telegram is loaded', async () => {
  // a state dir .env with no TELEGRAM_BOT_TOKEN, an empty machine config, nothing in the env
  const d = await spawnDaemon('a', join(PLUGIN, 'server.ts'), { GENESIS_LANES: '0' }, { probe: true, machine: '', stateEnv: 'SOMETHING_ELSE=1\n' })
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
    expect(d.log()).toContain('the bot token in the env is not used')
    expect(existsSync(d.probeOut)).toBe(false)
  }
  await sleep(1500)
  expect(api.calls).toEqual([])
  expect(api.polls).toEqual([])
}, 60000)

/** every .ts of telegram-http and agent-inbox that is not a test, a test fixture, roamer-telegram.ts, or telegram-bridge/ (another program) */
function daemonSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      if (n === 'node_modules' || n === 'test-fixtures' || n === 'telegram-bridge') continue
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (n.endsWith('.ts') && !n.endsWith('.test.ts') && n !== 'roamer-telegram.ts') out.push(p)
    }
  }
  walk(join(PLUGINS, 'telegram-http'))
  walk(join(PLUGINS, 'agent-inbox'))
  return out.sort()
}
// the same search as a shell one-liner (CHANGELOG 1.59.0):
//   cd plugins && grep -rnE 'grammy|api\.telegram\.org|bot\.api|getUpdates' --include='*.ts' telegram-http agent-inbox | grep -v node_modules \
//     | grep -v '\.test\.ts:' | grep -vE '^telegram-http/(roamer-telegram\.ts|telegram-bridge/|test-fixtures/)'
test('(b) the search: no daemon source but roamer-telegram.ts mentions grammy, api.telegram.org, bot.api or getUpdates', () => {
  const files = daemonSources()
  expect(files.some(f => f.endsWith('/telegram-http/server.ts'))).toBe(true)
  expect(files.some(f => f.endsWith('/agent-inbox/server.ts'))).toBe(true)
  expect(files.some(f => f.endsWith('/telegram-http/roamer-control.ts'))).toBe(true)          // a roamer's control plane, loaded by every daemon: searched
  const hits: string[] = []
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (/grammy|api\.telegram\.org|bot\.api|getUpdates/.test(l)) hits.push(`${relative(PLUGINS, f)}:${i + 1}: ${l.trim().slice(0, 120)}`) })
  }
  expect(hits).toEqual([])
  // the one file it all moved to does hold it (the search would pass trivially if the code had only been renamed away)
  const rt = readFileSync(join(PLUGIN, 'roamer-telegram.ts'), 'utf8')
  expect(rt).toContain("from 'grammy'")
  expect(rt).toContain('this.bot.api.')
  // tg-fetch.ts (the hand-over's connection drain) is gone
  expect(existsSync(join(PLUGIN, 'tg-fetch.ts'))).toBe(false)
})

test('(b) server.ts loads roamer-telegram.ts once, by a dynamic import behind ROAMER (ROAMER_MODE=1, not the agent-inbox daemon); nothing else names it', () => {
  const src = readFileSync(join(PLUGIN, 'server.ts'), 'utf8')
  const runtime = [...src.matchAll(/import\(\s*['"]\.\/roamer-telegram\.ts['"]\s*\)/g)]
  expect(runtime.length).toBe(1)
  expect(src).toMatch(/const tg: RoamerTelegram \| null = ROAMER\n\s*\? new \(await import\('\.\/roamer-telegram\.ts'\)\)\.RoamerTelegram\(/)
  expect(src).toContain('const ROAMER = !INBOX_ONLY && Onsen.isRoamerEnv(process.env)')
  expect(src).toContain('const CONNECTOR = !INBOX_ONLY && !ROAMER')
  // the only static mention is a type import (erased when Bun runs the file)
  const statics = src.split('\n').filter(l => /^\s*import\b/.test(l) && l.includes('roamer-telegram'))
  expect(statics).toEqual(["import type { RoamerTelegram, RoamerHost } from './roamer-telegram.ts'"])
  // isRoamerEnv is ROAMER_MODE=1 and nothing else
  expect(readFileSync(join(PLUGIN, 'onsen-client.ts'), 'utf8')).toContain("export const isRoamerEnv = (env: NodeJS.ProcessEnv): boolean => (env.ROAMER_MODE ?? '').trim() === '1'")
  // no other daemon source imports the file (statically or dynamically)
  const imports = /import\b[^\n]*['"][^'"]*roamer-telegram(\.ts)?['"]|import\(\s*['"][^'"]*roamer-telegram/
  for (const f of daemonSources()) if (!f.endsWith('/telegram-http/server.ts')) expect([f, imports.test(readFileSync(f, 'utf8'))]).toEqual([f, false])
  // the token check: only a roamer exits without one
  expect(src).toContain('if (!TOKEN && ROAMER) {')
})

test('(c) a roamer: polls the stand-in, an update reaches its target session only, the reply goes out; no target: told on Telegram', async () => {
  const api = startBotApiMock({}, { pollHoldMs: 200 }); apis.push(api)
  const sleeper = Bun.spawn(['sleep', '600']); procs.push(sleeper)                 // the target's claude pid (alive)
  const stateFile = join(root, 'c-roamer-state.json')
  writeFileSync(stateFile, JSON.stringify({ current_target: { tmux: 'wo197-final-no-such-tmux', claude_pid: sleeper.pid, session_id: 'x', cwd: root } }))
  const d = await startTgDaemon(api, join(root, 'c'), JOEY, { ROAMER_MODE: '1', ROAMER_BOT_NAME: 'lab_test_bot', ROAMER_STATE_FILE: stateFile, GENESIS_LANES: '0',
    TMUX_TMPDIR: join(root, 'c-tmux') })
  const h = await health(d.port)
  expect(h.polling).toBe(true)
  expect(h.bot_username).toBe('lab_test_bot')
  expect(h.connector).toMatchObject({ on: false, roamer: true, token: true, bot_api_refused: {} })
  expect(d.log()).toContain('roamer (ROAMER_MODE=1): the Telegram long poll is started (roamer-telegram.ts)')
  // the target connects first (the one unclaimed session: adopted), then a second session that is not the target
  const got: Record<string, string[]> = { target: [], other: [] }
  const client = async (who: 'target' | 'other') => {
    const c = new Client({ name: `wo197-${who}`, version: '0' }, { capabilities: {} })
    c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') got[who]!.push(String((n.params as any).content)) }
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${d.port}/mcp`)))
    return c
  }
  const target = await client('target')
  await sleep(600)
  api.push(dm(JOEY, 101, '第一則'))
  expect(await until(() => got.target!.includes('第一則'), 10000)).toBe(true)
  const other = await client('other')
  await sleep(600)
  api.push(dm(JOEY, 102, '第二則'))
  expect(await until(() => got.target!.includes('第二則'), 10000)).toBe(true)
  await sleep(500)
  expect(got.other).toEqual([])                                                    // routed to the target only, never broadcast
  // the reply tool: out to the stand-in, threaded under Joey's message
  const r = await d.call('reply', { chat_id: String(JOEY), text: '收到', reply_to: '102' })
  expect(r.isError).toBe(false)
  expect(r.text).toMatch(/^sent \(id: \d+\)$/)
  const sent = api.of('sendRichMessage').at(-1)!
  expect(sent.body).toMatchObject({ chat_id: String(JOEY), rich_message: { markdown: '收到' }, reply_parameters: { message_id: 102 } })
  expect((await d.call('react', { chat_id: String(JOEY), message_id: '102', emoji: '👍' })).isError).toBe(false)
  expect(api.of('setMessageReaction').at(-1)!.body).toMatchObject({ chat_id: String(JOEY), message_id: 102 })
  expect(api.of('setMyCommands').length).toBeGreaterThanOrEqual(1)
  // no target: the roamer says so on Telegram, nothing is delivered
  writeFileSync(stateFile, JSON.stringify({ current_target: null }))
  const n = got.target!.length
  api.push(dm(JOEY, 103, '沒有 target'))
  expect(await until(() => api.of('sendMessage').some(c => String(c.body.text ?? '').includes('尚未連線 target')), 10000)).toBe(true)
  expect(got.target!.length).toBe(n)
  await target.close(); await other.close(); await d.stop()
}, 60000)

test('(c) a roamer with no bot token exits as before (code 1, the same lines); with the probe it cannot start (the probe sees Telegram code load)', async () => {
  const none = await spawnDaemon('c2', join(PLUGIN, 'server.ts'), { ROAMER_MODE: '1', GENESIS_LANES: '0' })
  expect(await none.proc.exited).toBe(1)
  const err = await new Response(none.proc.stderr as ReadableStream).text()
  expect(err).toContain('telegram channel: TELEGRAM_BOT_TOKEN required')
  expect(err).toContain('format: TELEGRAM_BOT_TOKEN=123456789:AAH...')
  const api = startBotApiMock({}, { pollHoldMs: 200 }); apis.push(api)
  const probed = await spawnDaemon('c3', join(PLUGIN, 'server.ts'), { ROAMER_MODE: '1', GENESIS_LANES: '0', TELEGRAM_BOT_TOKEN: api.token, TELEGRAM_API_ROOT: api.url }, { probe: true })
  expect(await Promise.race([probed.proc.exited.then(() => 'exited'), sleep(15000).then(() => 'running')])).toBe('exited')
  expect(readFileSync(probed.probeOut, 'utf8')).toMatch(/roamer-telegram\.ts|grammy/)
  expect(api.polls).toEqual([])
}, 40000)

test('(d) the agent-inbox daemon (CHANNEL_INBOX_ONLY, the same engine) starts with the probe: no Telegram code loaded', async () => {
  const d = await spawnDaemon('d', join(PLUGINS, 'agent-inbox', 'server.ts'), { AGENT_INBOX_SELF: 'adam' }, { probe: true })
  expect(await until(async () => (await health(d.port))?.ok === true, 20000)).toBe(true)
  const h = await health(d.port)
  expect(h.plugin).toBe('telegram-http')
  expect('connector' in h).toBe(false)
  expect(h.polling).toBe(false)
  expect(existsSync(d.probeOut)).toBe(false)
  expect(d.log()).toContain('agent-inbox mode')
  expect(d.proc.exitCode).toBe(null)
}, 40000)
