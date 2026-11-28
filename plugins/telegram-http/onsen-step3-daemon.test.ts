// Session registry and status, with a loopback Onsen and disposable daemons.
import { test, expect, afterAll, beforeAll } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, chmodSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBotApiMock, dm, type BotApiMock } from './test-fixtures/tg-bot-api-mock.ts'
import { queuedTags, startTgDaemon, until, freePort, type TgDaemon } from './test-fixtures/tg-daemon.ts'

const JOEY = 1828
const CRED = 'mesh_STEP3DAEMONsecretSECRETsecret0123456'
let api: BotApiMock, off: TgDaemon, on: TgDaemon, onsenPort: number
let up: ReturnType<typeof Bun.serve> | null = null
const got: Array<{ path: string; item: any; at: number; seq: number }> = []
let seq = 0, next = 1
const procs: any[] = []
let sharedDir = ''

function startOnsen(): void {
  up = Bun.serve({ port: onsenPort, hostname: '127.0.0.1', async fetch(req) {
    const u = new URL(req.url), path = u.pathname.replace(/^\/api\/onsen/, '')
    const body = req.method === 'POST' ? await req.json() : undefined
    if (req.headers.get('authorization') !== `Bearer ${CRED}`) return Response.json({ error: 'auth' }, { status: 401 })
    if (path === '/messages/batch' || path === '/deliveries/batch' || path === '/status/batch') {
      for (const it of body.items) got.push({ path, item: it, at: Date.now(), seq: ++seq })
      return Response.json({ results: body.items.map(() => ({ id: next++, duplicate: false })) })
    }
    if (path === '/events') return Response.json({ id: next++, duplicate: false })
    return Response.json({ error: 'no route' }, { status: 404 })
  } })
}
const facts = (agentChat: string, id: number) => got.filter(g => g.path === '/deliveries/batch' && g.item.client_msg_id === String(id) && g.item.chat === agentChat)
const states = (id: number) => facts(String(JOEY), id).map(g => `${g.item.state}${g.item.by ? `:${g.item.by}` : ''}`)
const statuses = (agent: string) => got.filter(g => g.path === '/status/batch' && g.item.agent === agent).map(g => g.item)

beforeAll(async () => {
  api = startBotApiMock({}, { pollHoldMs: 300 })
  onsenPort = await freePort()
  startOnsen()
  const root = mkdtempSync(join(tmpdir(), 'onsen3-daemon-'))
  const env = { ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, FIXTURE_MEMBER_TOKEN: CRED }
  // a stand-in `claude agents --json`: the registry files under the daemon's HOME, as the CLI prints them (shell shows as busy; --cwd: that folder and below)
  writeFileSync(join(root, 'fake-agents.ts'), `import { readdirSync, readFileSync } from 'fs'
const d = process.env.HOME + '/.claude/sessions', i = process.argv.indexOf('--cwd'), cwd = i > 0 ? process.argv[i + 1] : ''
let a = []
try { a = readdirSync(d).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(d + '/' + n, 'utf8'))) } catch {}
console.log(JSON.stringify(a.filter(e => !cwd || e.cwd === cwd || e.cwd.startsWith(cwd + '/')).map(e => ({ pid: e.pid, cwd: e.cwd, kind: e.kind, startedAt: e.startedAt,
  sessionId: e.sessionId, name: e.name, status: e.status === 'shell' ? 'busy' : e.status }))))
`)
  writeFileSync(join(root, 'fake-claude'), `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'fake-agents.ts')}" "$@"\n`)
  chmodSync(join(root, 'fake-claude'), 0o755)
  // the test's MCP client is not a claude process: the stream's peer lookup is off (every open stream counts as the main's; Streams is unit-tested)
  off = await startTgDaemon(api, join(root, 'off'), JOEY, { ...env, GENESIS_LANES: '0', ONSEN_PEER_LOOKUP: '0', ONSEN_CLAUDE_BIN: join(root, 'fake-claude'),
    ONSEN_REGISTRY_FIRST_CHECK_MS: '300', ONSEN_SHARED_DIR: (sharedDir = join(root, 'shared')) })
}, 40000)
afterAll(async () => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } await off?.stop(); await on?.stop(); api?.stop(); up?.stop(true) })

async function exerciseRegistry(): Promise<number[]> {
  const sessions = join(off.home, '.claude', 'sessions')
  const tdir = join(off.home, '.claude', 'projects', off.ws.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(sessions, { recursive: true }); mkdirSync(tdir, { recursive: true })
  const last = () => statuses('adam').at(-1)
  expect(await until(() => statuses('adam').length > 0, 10000)).toBe(true)
  expect(statuses('adam')[0]).toMatchObject({ state: 'offline', detail: { reason: 'no_registration' }, idem_key: expect.stringMatching(/^tg:adam:st:\d+:offline$/) })
  expect('last_activity_at' in statuses('adam')[0]).toBe(true)
  // the main registers (Claude Code's registry file): it holds no stream here yet: offline not_connected
  const main = Bun.spawn(['sleep', '600']); procs.push(main)
  const lstart = (pid: number) => String(spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).stdout ?? '').trim()
  const sid = randomUUID()
  const regFile = (pid: number) => join(sessions, `${pid}.json`)
  const reg = (o: Record<string, unknown> = {}, pid = main.pid) => writeFileSync(regFile(pid), JSON.stringify({ pid, sessionId: sid, cwd: off.ws, startedAt: Date.now(),
    procStart: lstart(pid), version: '2.1.322', kind: 'interactive', entrypoint: 'cli', name: 'adam', status: 'idle', updatedAt: Date.now(), statusUpdatedAt: Date.now(), ...o }))
  const tf = join(tdir, `${sid}.jsonl`)
  writeFileSync(tf, '')
  reg()
  expect(await until(() => last()?.detail?.reason === 'not_connected', 10000)).toBe(true)
  // a session opens: the parked message is written into its stream: in_session by the main (WO-165: not seen yet); idle (the registry's)
  const received: string[] = []
  const c = new Client({ name: 'onsen3-test', version: '0' }, { capabilities: {} })
  c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') received.push(String((n.params as any)?.meta?.message_id ?? '')) }
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${off.port}/mcp`)))
  expect(await until(() => last()?.state === 'idle', 10000)).toBe(true)
  // the latency: a registry write → the status line in the daemon's spool (a state change is written at once)
  const spool = join(off.stateDir, 'onsen', 'spool.jsonl')
  const spoolStates = () => existsSync(spool) ? readFileSync(spool, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.k === 's').map(l => l.r.state) : []
  const registryWriteLatency: number[] = []
  for (const st of ['busy', 'idle', 'waiting', 'idle', 'busy']) {
    const n = spoolStates().length, t0 = performance.now()
    reg({ status: st, ...(st === 'waiting' ? { waitingFor: 'permission prompt' } : {}) })
    while (!(spoolStates().length > n && spoolStates().at(-1) === st) && performance.now() - t0 < 5000) await Bun.sleep(3)   // read every 3 ms
    expect(spoolStates().at(-1)).toBe(st)
    registryWriteLatency.push(performance.now() - t0)
    await Bun.sleep(100)
  }
  console.log(`registry write → status line in the spool (ms): ${registryWriteLatency.map(x => x.toFixed(0)).join(', ')}`)
  expect(await until(() => statuses('adam').some(s => s.state === 'waiting' && s.detail?.waitingFor === 'permission prompt'), 10000)).toBe(true)
  // busy: the transcript's turn rides as detail (the tool, since); last_activity_at = the transcript's last write. The user record takes 5001 in: seen
  const promptAt = new Date().toISOString()
  writeFileSync(tf, JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: `<channel source="plugin:telegram-http:telegram-http" chat_id="${JOEY}" message_id="5001" user="joey" user_id="${JOEY}" ts="x">\n還沒有人在\n</channel>` }, timestamp: promptAt }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] }, timestamp: new Date().toISOString() }) + '\n')
  expect(await until(() => last()?.state === 'busy' && last()?.detail?.tool?.name === 'Bash', 20000)).toBe(true)
  expect(last()!.detail).toMatchObject({ subagents: 0, queued_joey: 0 })
  expect(typeof last()!.detail.tool.since).toBe('string')
  const { statSync } = await import('fs')
  expect(await until(() => Math.abs(Date.parse(last()?.last_activity_at ?? '') - statSync(tf).mtimeMs) < 2, 10000)).toBe(true)
  // nothing written for longer than ONSEN_STUCK_S (600 s) while busy: stuck
  const old = new Date(Date.now() - 20 * 60_000)
  utimesSync(tf, old, old)
  expect(await until(() => last()?.state === 'stuck', 10000)).toBe(true)
  expect(last()!.detail).toMatchObject({ threshold_s: 600 })
  expect(Math.abs(Date.parse(last()!.last_activity_at) - old.getTime())).toBeLessThan(1000)
  // the turn ends (turn_duration) and the registry says idle: turn_end, idle
  appendFileSync(tf, JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1200, timestamp: new Date().toISOString() }) + '\n')
  reg({ status: 'idle' })
  expect(await until(() => last()?.state === 'idle', 10000)).toBe(true)
  // the process is gone (its file left behind): pid_gone; a pid that lives but started at another time: pid_reused
  main.kill('SIGKILL'); await main.exited
  expect(await until(() => last()?.detail?.reason === 'pid_gone', 10000)).toBe(true)
  rmSync(regFile(main.pid))
  const other = Bun.spawn(['sleep', '600']); procs.push(other)
  if (spawnSync('ps', ['-o', 'lstart=', '-p', String(other.pid)]).status === 0) {
    reg({ procStart: 'Mon Jan  1 00:00:00 2024' }, other.pid)
    expect(await until(() => last()?.detail?.reason === 'pid_reused', 10000)).toBe(true)
  }
  // a stranger's message (not on the allowlist) gets no facts
  api.push(dm(4242, 5002, 'stranger'))
  await Bun.sleep(1500)
  expect(facts('4242', 5002)).toEqual([])
  const h = await fetch(`http://127.0.0.1:${off.port}/healthz`).then(r => r.json()) as any
  expect(h.onsen).toMatchObject({ record: true, pending_bytes: 0 })
  expect(h.onsen.status_recorded).toBeGreaterThanOrEqual(8)
  expect(h.onsen.status).toMatchObject({ state: 'offline', mode: 'transcript', registry: { via: 'files', check: { agree: true } } })
  // 1.48.3: the comparison went through the machine's shared read (one run at a time, answer in the cache file), the CLI run without --cwd
  expect(JSON.parse(readFileSync(join(sharedDir, 'agents-cli.json'), 'utf8'))).toMatchObject({ at: expect.any(Number), out: expect.stringContaining('[') })
  expect(existsSync(join(sharedDir, 'agents-cli.lock'))).toBe(false)
  expect(off.log()).toContain('onsen: step 3 on')
  expect(off.log()).not.toContain(CRED)
  await c.close()
  return registryWriteLatency
}

let registryRun: Promise<number[]> | undefined
const registryResult = () => registryRun ??= exerciseRegistry()

test('lanes off: the main status follows registry, stream and transcript changes', async () => {
  await registryResult()
}, 120000)

test('five registry changes reach the status spool within one second each', async () => {
  const registryWriteLatency = await registryResult()
  expect(registryWriteLatency).toHaveLength(5)
  expect(Math.max(...registryWriteLatency)).toBeLessThan(1000)
}, 120000)

test('lanes on: delivered after the message; no main registered: offline no_registration; the tap is attached (the journal writes go on)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onsen3-daemon-on-'))
  const api2 = startBotApiMock({}, { pollHoldMs: 300 })
  try {
    on = await startTgDaemon(api2, root, JOEY, { ONSEN_BASE: `http://127.0.0.1:${onsenPort}/api/onsen`, FIXTURE_MEMBER_TOKEN: CRED,
      LANES_AGENT: 'eve', AGENT_INBOX_SELF: 'eve' })
    expect(await until(() => statuses('eve').length > 0, 10000)).toBe(true)
    expect(statuses('eve')[0]).toMatchObject({ state: 'offline', detail: { reason: 'no_registration' } })
    api2.push(dm(JOEY, 6001, '主線不在'))
    expect(await until(() => queuedTags(on).some(t => t.meta.message_id === '6001'))).toBe(true)
    expect(got.some(g => g.path === '/deliveries/batch')).toBe(false)
    const h = await fetch(`http://127.0.0.1:${on.port}/healthz`).then(r => r.json()) as any
    expect(h.onsen.status).toMatchObject({ state: 'offline', mode: 'lanes' })
  } finally { await on?.stop(); api2.stop() }
}, 60000)
